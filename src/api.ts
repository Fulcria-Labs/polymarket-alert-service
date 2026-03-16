/**
 * API Handler for Prediction Market Alert Service
 *
 * Endpoints:
 * - POST /alerts - Create new alert (requires x402 payment)
 * - GET /alerts - List user's alerts
 * - GET /markets/search?q=query - Search prediction markets
 * - GET /health - Health check
 * - GET /feeds - List all supported Chainlink price feeds
 * - GET /feeds/:pair - Get latest Chainlink price feed data
 * - POST /alerts/hybrid - Create hybrid alert combining oracle + market conditions
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import workflow, { parseAlertRequest, parseMultiConditionAlert, extractSearchKeywords, searchMarkets, fetchMarketData, validateWebhookUrl, analyzeTrend, recordPriceSnapshot } from './polymarket-alert-workflow';
import type { PriceSnapshot } from './polymarket-alert-workflow';
import { createPortfolio, calculatePortfolioPerformance, recordPortfolioSnapshot, buildCorrelationMatrix, detectDivergences, scanForArbitrage } from './portfolio';
import type { Portfolio, PortfolioSnapshot } from './portfolio';
import x402 from './x402-handler';
import { CHAINLINK_FEEDS, ChainlinkPriceFeed, createHybridAlert, evaluateHybridAlert } from './chainlink-data-feeds';
import type { HybridAlertConfig } from './chainlink-data-feeds';

// Initialize state (would be persisted in production)
const state: {
  alertConfigs: any[];
  lastChecked: Record<string, number>;
  triggeredAlerts: string[];
  pendingPayments: Map<string, { nonce: string; config: any; expiry: number }>;
  priceHistory: Record<string, PriceSnapshot[]>;
  portfolios: Map<string, Portfolio>;
  portfolioSnapshots: Map<string, PortfolioSnapshot[]>;
  hybridAlerts: HybridAlertConfig[];
} = {
  alertConfigs: [],
  lastChecked: {},
  triggeredAlerts: [],
  pendingPayments: new Map(),
  priceHistory: {},
  portfolios: new Map(),
  portfolioSnapshots: new Map(),
  hybridAlerts: [],
};

// Shared Chainlink price feed instance (uses Base by default; no live provider in demo)
const priceFeed = new ChainlinkPriceFeed({ network: 'base' });

const app = new Hono();

// CORS for frontend access
app.use('*', cors());

// Serve dashboard
app.get('/', async (c) => {
  const file = Bun.file('./public/index.html');
  if (await file.exists()) {
    return new Response(file, { headers: { 'Content-Type': 'text/html' } });
  }
  return c.redirect('/health');
});

// Health check
app.get('/health', (c) => {
  return c.json({
    status: 'healthy',
    version: workflow.version,
    alertCount: state.alertConfigs.length,
    timestamp: new Date().toISOString(),
  });
});

// Search markets
app.get('/markets/search', async (c) => {
  const query = c.req.query('q');
  if (!query || query.length < 2) {
    return c.json({ error: 'Query must be at least 2 characters' }, 400);
  }

  const markets = await searchMarkets(query);
  return c.json({
    query,
    count: markets.length,
    markets: markets.map(m => ({
      id: m.condition_id,
      question: m.question,
      outcomes: m.outcomes,
      currentPrices: m.tokens.map(t => ({
        outcome: t.outcome,
        price: (t.price * 100).toFixed(1) + '%',
      })),
    })),
  });
});

// Get market details
app.get('/markets/:id', async (c) => {
  const marketId = c.req.param('id');
  const market = await fetchMarketData(marketId);

  if (!market) {
    return c.json({ error: 'Market not found' }, 404);
  }

  return c.json({
    id: market.condition_id,
    question: market.question,
    active: market.active,
    closed: market.closed,
    outcomes: market.tokens.map(t => ({
      name: t.outcome,
      price: (t.price * 100).toFixed(1) + '%',
      tokenId: t.token_id,
    })),
    volume: market.volume,
  });
});

// Get price history for a market
app.get('/markets/:id/history', async (c) => {
  const marketId = c.req.param('id');
  const hours = parseInt(c.req.query('hours') || '24');
  const snapshots = state.priceHistory[marketId] || [];

  // Filter by time window
  const cutoff = Date.now() - (hours * 3600000);
  const filtered = snapshots.filter(s => s.timestamp >= cutoff);

  return c.json({
    marketId,
    hours,
    dataPoints: filtered.length,
    history: filtered.map(s => ({
      timestamp: new Date(s.timestamp).toISOString(),
      prices: s.prices,
    })),
  });
});

// Get trend analysis for a market
app.get('/markets/:id/trend', async (c) => {
  const marketId = c.req.param('id');
  const outcome = c.req.query('outcome') || 'Yes';
  const snapshots = state.priceHistory[marketId];

  if (!snapshots || snapshots.length === 0) {
    // Try to seed with current data
    const market = await fetchMarketData(marketId);
    if (market) {
      recordPriceSnapshot(state.priceHistory, marketId, market);
      const trend = analyzeTrend(state.priceHistory[marketId] ?? [], outcome);
      return c.json({
        marketId,
        trend,
        note: 'First data point recorded. Trend analysis improves with more history.',
      });
    }
    return c.json({ error: 'No price history available for this market' }, 404);
  }

  const trend = analyzeTrend(snapshots, outcome);
  return c.json({ marketId, trend });
});

// Create alert - requires x402 payment
app.post('/alerts', async (c) => {
  const body = await c.req.json();

  // Check for payment proof
  const paymentProof = c.req.header('X-Payment-Proof');

  if (!paymentProof) {
    // No payment - return 402 with payment instructions
    const { status, headers, body: paymentBody } = x402.createPaymentRequired(
      '/alerts',
      `Create prediction market alert: ${body.description || 'Custom alert'}`
    );

    // Store pending payment for verification
    state.pendingPayments.set(paymentBody.nonce, {
      nonce: paymentBody.nonce,
      config: body,
      expiry: paymentBody.expiry,
    });

    // Clean up expired pending payments
    const now = Math.floor(Date.now() / 1000);
    for (const [nonce, pending] of state.pendingPayments.entries()) {
      if (pending.expiry < now) {
        state.pendingPayments.delete(nonce);
      }
    }

    for (const [key, value] of Object.entries(headers)) {
      c.header(key, value);
    }
    return c.json(paymentBody, status);
  }

  // Verify payment
  try {
    const proof = JSON.parse(paymentProof);
    const verification = await x402.verifyPayment(proof);

    if (!verification.valid) {
      return c.json({ error: `Payment invalid: ${verification.error}` }, 402);
    }
  } catch (error) {
    return c.json({ error: 'Invalid payment proof format' }, 400);
  }

  // Payment verified - create alert
  const {
    marketId,
    outcome = 'Yes',
    threshold,
    direction = 'above',
    notifyUrl,
    naturalLanguage,
  } = body;

  // Handle natural language input
  if (naturalLanguage && !marketId) {
    // Try multi-condition parsing first
    const multiParsed = parseMultiConditionAlert(naturalLanguage, notifyUrl || '');

    if (multiParsed.length > 1) {
      // Multiple conditions - create multiple alerts
      const createdAlerts: any[] = [];
      const keywords = extractSearchKeywords(naturalLanguage);

      for (const parsed of multiParsed) {
        // Search with extracted keywords
        let markets: any[] = [];
        for (const kw of keywords) {
          markets = await searchMarkets(kw);
          if (markets.length > 0) break;
        }

        if (markets.length > 0) {
          parsed.marketId = markets[0].condition_id;
          parsed.notifyUrl = notifyUrl || '';
          state.alertConfigs.push(parsed);
          createdAlerts.push({
            id: state.alertConfigs.length - 1,
            market: markets[0].question,
            outcome: parsed.outcome,
            threshold: parsed.threshold,
            direction: parsed.direction,
          });
        }
      }

      if (createdAlerts.length === 0) {
        return c.json({
          error: 'No matching markets found for conditions',
          parsedConditions: multiParsed.length,
        }, 404);
      }

      return c.json({
        success: true,
        multiAlert: true,
        alertsCreated: createdAlerts.length,
        alerts: createdAlerts,
      }, 201);
    }

    // Single condition parsing
    const parsed = parseAlertRequest(naturalLanguage, notifyUrl || '');
    if (!parsed) {
      return c.json({
        error: 'Could not parse natural language request',
        hint: 'Try: "when Trump election odds exceed 60%"',
        examples: [
          'Alert when Trump > 60%',
          'Notify if recession odds fall below 30%',
          'Watch Bitcoin ETF approval at 70 cents',
          'Tell me when No hits 40% on AI regulation',
        ],
      }, 400);
    }

    // Extract smart search keywords from the request
    const keywords = extractSearchKeywords(naturalLanguage);
    let markets: any[] = [];

    // Try each keyword until we find markets
    for (const kw of keywords) {
      markets = await searchMarkets(kw);
      if (markets.length > 0) break;
    }

    // Fallback to full query
    if (markets.length === 0) {
      markets = await searchMarkets(naturalLanguage);
    }

    if (markets.length === 0) {
      return c.json({
        error: 'No matching markets found',
        query: naturalLanguage,
        searchedKeywords: keywords,
      }, 404);
    }

    // Use first matching market
    parsed.marketId = markets[0].condition_id;
    parsed.notifyUrl = notifyUrl || '';

    state.alertConfigs.push(parsed);

    return c.json({
      success: true,
      alert: {
        id: state.alertConfigs.length - 1,
        market: markets[0].question,
        outcome: parsed.outcome,
        threshold: parsed.threshold,
        direction: parsed.direction,
      },
      matchedKeywords: keywords,
    }, 201);
  }

  // Standard structured input
  if (!marketId || !threshold || !notifyUrl) {
    return c.json({
      error: 'Missing required fields: marketId, threshold, notifyUrl',
    }, 400);
  }

  // Validate webhook URL against SSRF
  const webhookCheck = validateWebhookUrl(notifyUrl);
  if (!webhookCheck.valid) {
    return c.json({ error: `Invalid webhook URL: ${webhookCheck.error}` }, 400);
  }

  // Verify market exists
  const market = await fetchMarketData(marketId);
  if (!market) {
    return c.json({ error: 'Market not found' }, 404);
  }

  const alertConfig = {
    marketId,
    outcome,
    threshold: parseFloat(threshold),
    direction: direction as 'above' | 'below',
    notifyUrl,
  };

  state.alertConfigs.push(alertConfig);

  return c.json({
    success: true,
    alert: {
      id: state.alertConfigs.length - 1,
      market: market.question,
      ...alertConfig,
    },
  }, 201);
});

// List alerts (would require auth in production)
app.get('/alerts', (c) => {
  return c.json({
    count: state.alertConfigs.length,
    alerts: state.alertConfigs.map((config, i) => ({
      id: i,
      ...config,
      triggered: state.triggeredAlerts.includes(
        `${config.marketId}-${config.outcome}-${config.threshold}-${config.direction}`
      ),
    })),
  });
});

// Delete alert
app.delete('/alerts/:id', (c) => {
  const id = parseInt(c.req.param('id'));
  if (isNaN(id) || id < 0 || id >= state.alertConfigs.length) {
    return c.json({ error: 'Alert not found' }, 404);
  }

  state.alertConfigs.splice(id, 1);
  return c.json({ success: true });
});

// Get payment instructions
app.get('/payment-info', (c) => {
  return c.json({
    instructions: x402.getPaymentInstructions(),
    receiver: x402.PAYMENT_RECEIVER,
    asset: x402.USDC_ADDRESS_BASE,
    amount: parseInt(x402.ALERT_PRICE_USDC) / 1e6,
    network: 'Base',
    chainId: x402.BASE_CHAIN_ID,
  });
});

// Calculate bulk pricing
app.get('/pricing', (c) => {
  const count = parseInt(c.req.query('count') || '1');
  return c.json(x402.calculateBulkPrice(count));
});

// --- Portfolio Management ---

// Create portfolio
app.post('/portfolios', async (c) => {
  const body = await c.req.json();
  const { id, name, markets } = body;

  if (!id || !name || !markets || !Array.isArray(markets)) {
    return c.json({ error: 'Missing required fields: id, name, markets[]' }, 400);
  }

  try {
    const portfolio = createPortfolio(id, name, markets);
    state.portfolios.set(id, portfolio);
    state.portfolioSnapshots.set(id, []);
    return c.json({ success: true, portfolio }, 201);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// List portfolios
app.get('/portfolios', (c) => {
  const portfolios = Array.from(state.portfolios.values());
  return c.json({
    count: portfolios.length,
    portfolios: portfolios.map(p => ({
      id: p.id,
      name: p.name,
      marketCount: p.markets.length,
      createdAt: new Date(p.createdAt).toISOString(),
    })),
  });
});

// Get portfolio performance
app.get('/portfolios/:id', (c) => {
  const id = c.req.param('id');
  const portfolio = state.portfolios.get(id);
  if (!portfolio) {
    return c.json({ error: 'Portfolio not found' }, 404);
  }

  const performance = calculatePortfolioPerformance(portfolio, state.priceHistory);
  return c.json({ portfolio, performance });
});

// Delete portfolio
app.delete('/portfolios/:id', (c) => {
  const id = c.req.param('id');
  if (!state.portfolios.has(id)) {
    return c.json({ error: 'Portfolio not found' }, 404);
  }

  state.portfolios.delete(id);
  state.portfolioSnapshots.delete(id);
  return c.json({ success: true });
});

// --- Correlation Analysis ---

// Get correlation matrix for a set of markets
app.get('/correlation', (c) => {
  const marketIds = c.req.query('markets')?.split(',') || [];
  const outcome = c.req.query('outcome') || 'Yes';

  if (marketIds.length < 2) {
    return c.json({ error: 'Need at least 2 market IDs (comma-separated)' }, 400);
  }

  const matrix = buildCorrelationMatrix(marketIds, state.priceHistory, outcome);
  return c.json(matrix);
});

// Get divergences between correlated markets
app.get('/divergences', (c) => {
  const marketIds = c.req.query('markets')?.split(',') || [];
  const outcome = c.req.query('outcome') || 'Yes';
  const threshold = parseFloat(c.req.query('threshold') || '10');

  if (marketIds.length < 2) {
    return c.json({ error: 'Need at least 2 market IDs' }, 400);
  }

  const matrix = buildCorrelationMatrix(marketIds, state.priceHistory, outcome);
  const divergences = detectDivergences(matrix, state.priceHistory, outcome, threshold);

  return c.json({
    marketCount: marketIds.length,
    divergenceThreshold: threshold,
    divergences,
  });
});

// --- Arbitrage Detection ---

// Scan markets for arbitrage opportunities
app.post('/arbitrage/scan', async (c) => {
  const body = await c.req.json();
  const { markets, threshold } = body;

  if (!markets || !Array.isArray(markets)) {
    return c.json({ error: 'Provide markets[] array with id, question, outcomes' }, 400);
  }

  const opportunities = scanForArbitrage(markets, threshold || 3);
  return c.json({
    scannedCount: markets.length,
    opportunities,
  });
});

// --- Chainlink Price Feeds ---

// List all supported feeds
app.get('/feeds', (c) => {
  const feeds = Object.values(CHAINLINK_FEEDS).map(f => ({
    id: f.id,
    description: f.description,
    decimals: f.decimals,
    category: f.category,
    heartbeatSeconds: f.heartbeatSeconds,
    networks: Object.keys(f.addresses),
  }));
  return c.json({ count: feeds.length, feeds });
});

// Get latest price for a specific feed (e.g., /feeds/ETH-USD)
app.get('/feeds/:pair', async (c) => {
  const pair = c.req.param('pair').toUpperCase();
  const feed = CHAINLINK_FEEDS[pair];

  if (!feed) {
    return c.json({
      error: `Unknown feed: ${pair}`,
      supported: Object.keys(CHAINLINK_FEEDS),
    }, 404);
  }

  // In a live environment we'd call priceFeed.getLatestPrice(pair).
  // For the demo, return the feed metadata with a note about live access.
  return c.json({
    feedId: feed.id,
    description: feed.description,
    decimals: feed.decimals,
    category: feed.category,
    heartbeatSeconds: feed.heartbeatSeconds,
    addresses: feed.addresses,
    note: 'Connect an Ethereum provider (e.g., ethers.js + Base RPC) to fetch live prices via ChainlinkPriceFeed.getLatestPrice()',
  });
});

// Create hybrid alert combining oracle + market conditions
app.post('/alerts/hybrid', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const {
    description,
    oracleConditions = [],
    marketConditions = [],
    logic = 'AND',
    notifyUrl,
    timeWindowMs,
  } = body;

  if (!notifyUrl) {
    return c.json({ error: 'notifyUrl is required' }, 400);
  }

  try {
    const alert = createHybridAlert({
      description,
      oracleConditions,
      marketConditions,
      logic,
      notifyUrl,
      timeWindowMs,
    });

    state.hybridAlerts.push(alert);

    return c.json({
      success: true,
      alert: {
        id: alert.id,
        description: alert.description,
        logic: alert.logic,
        oracleConditionCount: alert.oracleConditions.length,
        marketConditionCount: alert.marketConditions.length,
        createdAt: new Date(alert.createdAt).toISOString(),
      },
    }, 201);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// List hybrid alerts
app.get('/alerts/hybrid', (c) => {
  return c.json({
    count: state.hybridAlerts.length,
    alerts: state.hybridAlerts.map(a => ({
      id: a.id,
      description: a.description,
      logic: a.logic,
      oracleConditions: a.oracleConditions,
      marketConditions: a.marketConditions,
      createdAt: new Date(a.createdAt).toISOString(),
    })),
  });
});

export default app;
