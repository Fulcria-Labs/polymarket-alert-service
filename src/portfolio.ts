/**
 * Portfolio & Correlation Analysis for Prediction Markets
 *
 * Features:
 * - Multi-market watchlist/portfolio tracking
 * - Pearson correlation between market price movements
 * - Arbitrage detection (mispriced outcome pairs)
 * - Portfolio-level alerts (divergence, aggregate thresholds)
 *
 * Integrates with CRE workflow for automated monitoring.
 */

import type { PriceSnapshot, TrendAnalysis } from './polymarket-alert-workflow';
import { analyzeTrend } from './polymarket-alert-workflow';

// --- Portfolio Types ---

export interface PortfolioMarket {
  marketId: string;
  label: string;           // Human-readable label (e.g., "Trump 2026")
  outcome: string;         // Which outcome to track (default: "Yes")
  weight: number;          // Portfolio weight (0-1, must sum to 1)
  addedAt: number;         // Timestamp
}

export interface Portfolio {
  id: string;
  name: string;
  markets: PortfolioMarket[];
  createdAt: number;
  updatedAt: number;
}

export interface PortfolioSnapshot {
  timestamp: number;
  marketPrices: Record<string, number>;  // marketId -> price
  weightedAverage: number;
}

export interface PortfolioPerformance {
  portfolioId: string;
  currentValue: number;           // Weighted average of current prices
  change1h: number | null;
  change6h: number | null;
  change24h: number | null;
  marketBreakdown: {
    marketId: string;
    label: string;
    currentPrice: number;
    weight: number;
    contribution: number;  // weight * price
    trend: TrendAnalysis;
  }[];
}

// --- Correlation Types ---

export interface CorrelationPair {
  marketA: string;
  marketB: string;
  correlation: number;      // Pearson r (-1 to 1)
  dataPoints: number;
  significance: 'strong_positive' | 'moderate_positive' | 'weak' | 'moderate_negative' | 'strong_negative';
}

export interface CorrelationMatrix {
  markets: string[];
  matrix: number[][];        // NxN correlation matrix
  pairs: CorrelationPair[];  // Sorted by |correlation| descending
}

// --- Arbitrage Types ---

export interface ArbitrageOpportunity {
  marketId: string;
  question: string;
  outcomes: { name: string; price: number }[];
  totalPrice: number;       // Sum of all outcome prices (should be ~100%)
  deviation: number;        // |totalPrice - 100|
  type: 'overpriced' | 'underpriced';
  potentialProfit: number;  // Theoretical profit in % terms
  confidence: 'high' | 'medium' | 'low';
}

export interface CrossMarketArbitrage {
  marketA: { id: string; question: string; outcome: string; price: number };
  marketB: { id: string; question: string; outcome: string; price: number };
  relationship: 'complementary' | 'contradictory' | 'correlated';
  combinedPrice: number;
  expectedCombined: number;
  deviation: number;
  opportunity: string;
}

// --- Portfolio Functions ---

/**
 * Create a new portfolio with validated market weights
 */
export function createPortfolio(
  id: string,
  name: string,
  markets: Omit<PortfolioMarket, 'addedAt'>[]
): Portfolio {
  if (markets.length === 0) {
    throw new Error('Portfolio must contain at least one market');
  }

  const totalWeight = markets.reduce((sum, m) => sum + m.weight, 0);
  if (Math.abs(totalWeight - 1.0) > 0.01) {
    throw new Error(`Portfolio weights must sum to 1.0 (got ${totalWeight.toFixed(4)})`);
  }

  const seen = new Set<string>();
  for (const m of markets) {
    if (seen.has(m.marketId)) {
      throw new Error(`Duplicate market ID: ${m.marketId}`);
    }
    seen.add(m.marketId);
  }

  const now = Date.now();
  return {
    id,
    name,
    markets: markets.map(m => ({ ...m, addedAt: now })),
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Calculate portfolio performance from price history
 */
export function calculatePortfolioPerformance(
  portfolio: Portfolio,
  priceHistory: Record<string, PriceSnapshot[]>,
): PortfolioPerformance {
  const breakdown = portfolio.markets.map(m => {
    const snapshots = priceHistory[m.marketId] || [];
    const trend = analyzeTrend(snapshots, m.outcome);

    return {
      marketId: m.marketId,
      label: m.label,
      currentPrice: trend.currentPrice,
      weight: m.weight,
      contribution: m.weight * trend.currentPrice,
      trend,
    };
  });

  const currentValue = breakdown.reduce((sum, b) => sum + b.contribution, 0);

  // Calculate portfolio-level changes by time window
  const calcChange = (window: '1h' | '6h' | '24h'): number | null => {
    let hasData = false;
    let pastValue = 0;

    for (const b of breakdown) {
      const key = `changePercent${window}` as keyof TrendAnalysis;
      const change = b.trend[key] as number | null;
      if (change !== null) {
        hasData = true;
        pastValue += b.weight * (b.currentPrice - change);
      } else {
        pastValue += b.contribution; // No change data, assume stable
      }
    }

    return hasData ? currentValue - pastValue : null;
  };

  return {
    portfolioId: portfolio.id,
    currentValue,
    change1h: calcChange('1h'),
    change6h: calcChange('6h'),
    change24h: calcChange('24h'),
    marketBreakdown: breakdown,
  };
}

/**
 * Record a portfolio snapshot for history tracking
 */
export function recordPortfolioSnapshot(
  snapshots: PortfolioSnapshot[],
  portfolio: Portfolio,
  priceHistory: Record<string, PriceSnapshot[]>,
  maxSnapshots: number = 288,
): void {
  const marketPrices: Record<string, number> = {};
  let weightedAvg = 0;

  for (const m of portfolio.markets) {
    const history = priceHistory[m.marketId] || [];
    if (history.length > 0) {
      const latest = history[history.length - 1];
      const price = latest.prices[m.outcome] || 0;
      marketPrices[m.marketId] = price;
      weightedAvg += m.weight * price;
    }
  }

  snapshots.push({
    timestamp: Date.now(),
    marketPrices,
    weightedAverage: parseFloat(weightedAvg.toFixed(2)),
  });

  if (snapshots.length > maxSnapshots) {
    snapshots.splice(0, snapshots.length - maxSnapshots);
  }
}

// --- Correlation Functions ---

/**
 * Calculate Pearson correlation coefficient between two price series
 */
export function pearsonCorrelation(xValues: number[], yValues: number[]): number {
  const n = Math.min(xValues.length, yValues.length);
  if (n < 3) return 0; // Need at least 3 points

  const x = xValues.slice(-n);
  const y = yValues.slice(-n);

  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;

  let numerator = 0;
  let denomX = 0;
  let denomY = 0;

  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    numerator += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }

  const denom = Math.sqrt(denomX * denomY);
  if (denom === 0) return 0;

  return parseFloat((numerator / denom).toFixed(4));
}

/**
 * Classify correlation strength
 */
export function classifyCorrelation(r: number): CorrelationPair['significance'] {
  const absR = Math.abs(r);
  if (r >= 0.7) return 'strong_positive';
  if (r >= 0.3) return 'moderate_positive';
  if (r <= -0.7) return 'strong_negative';
  if (r <= -0.3) return 'moderate_negative';
  return 'weak';
}

/**
 * Build correlation matrix for a set of markets
 */
export function buildCorrelationMatrix(
  marketIds: string[],
  priceHistory: Record<string, PriceSnapshot[]>,
  outcome: string = 'Yes',
): CorrelationMatrix {
  const n = marketIds.length;
  const matrix: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
  const pairs: CorrelationPair[] = [];

  // Extract price series for each market
  const series: Record<string, number[]> = {};
  for (const id of marketIds) {
    const snapshots = priceHistory[id] || [];
    series[id] = snapshots
      .filter(s => s.prices[outcome] !== undefined)
      .map(s => s.prices[outcome]);
  }

  // Build NxN matrix
  for (let i = 0; i < n; i++) {
    matrix[i][i] = 1.0; // Self-correlation
    for (let j = i + 1; j < n; j++) {
      const xSeries = series[marketIds[i]] || [];
      const ySeries = series[marketIds[j]] || [];
      const r = pearsonCorrelation(xSeries, ySeries);
      matrix[i][j] = r;
      matrix[j][i] = r;

      pairs.push({
        marketA: marketIds[i],
        marketB: marketIds[j],
        correlation: r,
        dataPoints: Math.min(xSeries.length, ySeries.length),
        significance: classifyCorrelation(r),
      });
    }
  }

  // Sort pairs by absolute correlation descending
  pairs.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));

  return { markets: marketIds, matrix, pairs };
}

/**
 * Find divergences: markets that are usually correlated but currently diverging
 */
export function detectDivergences(
  correlationMatrix: CorrelationMatrix,
  priceHistory: Record<string, PriceSnapshot[]>,
  outcome: string = 'Yes',
  divergenceThreshold: number = 10, // Percentage points
): {
  pair: CorrelationPair;
  currentPriceA: number;
  currentPriceB: number;
  expectedDiff: number;
  actualDiff: number;
  divergenceAmount: number;
}[] {
  const divergences: ReturnType<typeof detectDivergences> = [];

  for (const pair of correlationMatrix.pairs) {
    // Only check strongly correlated pairs
    if (Math.abs(pair.correlation) < 0.5 || pair.dataPoints < 5) continue;

    const historyA = priceHistory[pair.marketA] || [];
    const historyB = priceHistory[pair.marketB] || [];

    if (historyA.length === 0 || historyB.length === 0) continue;

    const currentA = historyA[historyA.length - 1].prices[outcome] ?? 0;
    const currentB = historyB[historyB.length - 1].prices[outcome] ?? 0;

    // For positively correlated markets, prices should move together
    // For negatively correlated, they should move apart
    const seriesA = historyA.map(s => s.prices[outcome] ?? 0);
    const seriesB = historyB.map(s => s.prices[outcome] ?? 0);

    // Calculate historical average difference
    const n = Math.min(seriesA.length, seriesB.length);
    let totalDiff = 0;
    for (let i = 0; i < n; i++) {
      totalDiff += seriesA[seriesA.length - n + i] - seriesB[seriesB.length - n + i];
    }
    const expectedDiff = totalDiff / n;
    const actualDiff = currentA - currentB;
    const divergenceAmount = Math.abs(actualDiff - expectedDiff);

    if (divergenceAmount >= divergenceThreshold) {
      divergences.push({
        pair,
        currentPriceA: currentA,
        currentPriceB: currentB,
        expectedDiff: parseFloat(expectedDiff.toFixed(2)),
        actualDiff: parseFloat(actualDiff.toFixed(2)),
        divergenceAmount: parseFloat(divergenceAmount.toFixed(2)),
      });
    }
  }

  // Sort by divergence amount descending
  divergences.sort((a, b) => b.divergenceAmount - a.divergenceAmount);
  return divergences;
}

// --- Arbitrage Detection ---

/**
 * Detect single-market arbitrage (outcome prices not summing to ~100%)
 */
export function detectSingleMarketArbitrage(
  marketId: string,
  question: string,
  outcomes: { name: string; price: number }[],
  deviationThreshold: number = 3, // % deviation to flag
): ArbitrageOpportunity | null {
  if (outcomes.length < 2) return null;

  const totalPrice = outcomes.reduce((sum, o) => sum + o.price, 0);
  const deviation = Math.abs(totalPrice - 100);

  if (deviation < deviationThreshold) return null;

  const type = totalPrice > 100 ? 'overpriced' : 'underpriced';
  const potentialProfit = deviation; // Simplified: profit is roughly the deviation

  let confidence: ArbitrageOpportunity['confidence'];
  if (deviation >= 10) confidence = 'high';
  else if (deviation >= 5) confidence = 'medium';
  else confidence = 'low';

  return {
    marketId,
    question,
    outcomes,
    totalPrice: parseFloat(totalPrice.toFixed(2)),
    deviation: parseFloat(deviation.toFixed(2)),
    type,
    potentialProfit: parseFloat(potentialProfit.toFixed(2)),
    confidence,
  };
}

/**
 * Detect cross-market arbitrage between related markets
 *
 * E.g., "Trump wins" + "GOP Senate majority" might be mispriced
 * relative to their historical correlation.
 */
export function detectCrossMarketArbitrage(
  marketA: { id: string; question: string; outcome: string; price: number },
  marketB: { id: string; question: string; outcome: string; price: number },
  relationship: CrossMarketArbitrage['relationship'],
  priceHistory: Record<string, PriceSnapshot[]>,
): CrossMarketArbitrage | null {
  let expectedCombined: number;
  const combinedPrice = marketA.price + marketB.price;

  switch (relationship) {
    case 'complementary':
      // Complementary events should sum to ~100%
      expectedCombined = 100;
      break;
    case 'contradictory':
      // Contradictory events: combined should be < 100%
      expectedCombined = 100;
      break;
    case 'correlated': {
      // Use historical correlation to estimate expected combined price
      const seriesA = (priceHistory[marketA.id] || []).map(
        s => s.prices[marketA.outcome] ?? 0
      );
      const seriesB = (priceHistory[marketB.id] || []).map(
        s => s.prices[marketB.outcome] ?? 0
      );
      if (seriesA.length < 3 || seriesB.length < 3) return null;

      const n = Math.min(seriesA.length, seriesB.length);
      let totalCombined = 0;
      for (let i = 0; i < n; i++) {
        totalCombined += seriesA[seriesA.length - n + i] + seriesB[seriesB.length - n + i];
      }
      expectedCombined = totalCombined / n;
      break;
    }
  }

  const deviation = Math.abs(combinedPrice - expectedCombined);
  if (deviation < 3) return null; // Insignificant

  const direction = combinedPrice > expectedCombined ? 'overpriced' : 'underpriced';
  const opportunity = combinedPrice > expectedCombined
    ? `Sell ${marketA.question} + ${marketB.question} (combined ${combinedPrice.toFixed(1)}% vs expected ${expectedCombined.toFixed(1)}%)`
    : `Buy ${marketA.question} + ${marketB.question} (combined ${combinedPrice.toFixed(1)}% vs expected ${expectedCombined.toFixed(1)}%)`;

  return {
    marketA,
    marketB,
    relationship,
    combinedPrice: parseFloat(combinedPrice.toFixed(2)),
    expectedCombined: parseFloat(expectedCombined.toFixed(2)),
    deviation: parseFloat(deviation.toFixed(2)),
    opportunity,
  };
}

/**
 * Scan multiple markets for arbitrage opportunities
 */
export function scanForArbitrage(
  markets: { id: string; question: string; outcomes: { name: string; price: number }[] }[],
  deviationThreshold: number = 3,
): ArbitrageOpportunity[] {
  const opportunities: ArbitrageOpportunity[] = [];

  for (const market of markets) {
    const opp = detectSingleMarketArbitrage(
      market.id,
      market.question,
      market.outcomes,
      deviationThreshold,
    );
    if (opp) {
      opportunities.push(opp);
    }
  }

  // Sort by potential profit descending
  opportunities.sort((a, b) => b.potentialProfit - a.potentialProfit);
  return opportunities;
}

// Export all for testing
export default {
  createPortfolio,
  calculatePortfolioPerformance,
  recordPortfolioSnapshot,
  pearsonCorrelation,
  classifyCorrelation,
  buildCorrelationMatrix,
  detectDivergences,
  detectSingleMarketArbitrage,
  detectCrossMarketArbitrage,
  scanForArbitrage,
};
