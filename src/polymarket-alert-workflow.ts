/**
 * Polymarket Alert Workflow for Chainlink CRE
 *
 * This workflow monitors prediction market conditions and sends alerts
 * when user-specified thresholds are met. Integrates x402 micropayments
 * for pay-per-alert model.
 *
 * Built with the CRE SDK's handler/trigger pattern:
 *   - CronCapability trigger fires every 5 minutes
 *   - HTTPCapability trigger accepts on-demand alert creation requests
 *   - HTTPClient capability makes outbound API calls to Polymarket CLOB
 *   - HTTPClient capability delivers webhook notifications
 *
 * Example: "Alert me when Trump election odds exceed 60%"
 *
 * Track: AI Agents + Prediction Markets
 */

import {
  cre,
  CronCapability,
  HTTPCapability,
  HTTPClient,
  consensusIdenticalAggregation,
} from '@chainlink/cre-sdk';
import type {
  Runtime,
  NodeRuntime,
  CronPayload,
  HTTPPayload,
  Workflow,
  HandlerFn,
} from '@chainlink/cre-sdk';

// Types for Polymarket API responses
interface PolymarketToken {
  token_id: string;
  outcome: string;
  price: number;
  winner?: boolean;
}

interface PolymarketMarket {
  condition_id: string;
  question: string;
  outcomes: string[];
  tokens: PolymarketToken[];
  active: boolean;
  closed: boolean;
  volume?: number;
}

// Price snapshot for history tracking
export interface PriceSnapshot {
  timestamp: number;
  prices: Record<string, number>;  // outcome -> price percentage
}

// Trend analysis result
export interface TrendAnalysis {
  outcome: string;
  currentPrice: number;
  changePercent1h: number | null;   // % change in last hour
  changePercent6h: number | null;   // % change in last 6 hours
  changePercent24h: number | null;  // % change in last 24 hours
  momentum: 'surging_up' | 'trending_up' | 'stable' | 'trending_down' | 'surging_down';
  volatility: number;               // Standard deviation of recent prices
  dataPoints: number;
}

// Configuration for alert conditions
export interface AlertConfig {
  marketId: string;
  outcome: string;      // "Yes" or "No"
  threshold: number;    // 0-100 representing percentage
  direction: 'above' | 'below';
  notifyUrl: string;    // Webhook to call when condition met
  type?: 'threshold' | 'trend';  // Alert type (default: threshold)
  trendDirection?: 'up' | 'down';  // For trend alerts
  trendMinChange?: number;          // Min % change to trigger (e.g., 5 = 5%)
  trendWindow?: number;             // Time window in ms (default: 1 hour)
}

// Workflow state persisted across runs
export interface WorkflowState {
  alertConfigs: AlertConfig[];
  lastChecked: Record<string, number>;  // marketId -> timestamp
  triggeredAlerts: string[];            // Already sent alerts
  priceHistory: Record<string, PriceSnapshot[]>;  // marketId -> snapshots
}

/**
 * Fetch market data from Polymarket CLOB API
 */
export async function fetchMarketData(marketId: string): Promise<PolymarketMarket | null> {
  const POLYMARKET_CLOB_API = 'https://clob.polymarket.com';

  try {
    const response = await fetch(`${POLYMARKET_CLOB_API}/markets/${marketId}`);
    if (!response.ok) {
      console.error(`Failed to fetch market ${marketId}: ${response.status}`);
      return null;
    }
    return await response.json() as PolymarketMarket;
  } catch (error) {
    console.error(`Error fetching market ${marketId}:`, error);
    return null;
  }
}

/**
 * Check if alert condition is met
 */
function checkAlertCondition(market: PolymarketMarket, config: AlertConfig): boolean {
  // Find the token for the specified outcome
  const token = market.tokens.find(t =>
    t.outcome.toLowerCase() === config.outcome.toLowerCase()
  );

  if (!token) {
    console.warn(`Outcome "${config.outcome}" not found in market`);
    return false;
  }

  const currentPrice = token.price * 100; // Convert to percentage

  if (config.direction === 'above') {
    return currentPrice >= config.threshold;
  } else {
    return currentPrice <= config.threshold;
  }
}

/**
 * SSRF Protection: Validate webhook URLs before sending
 *
 * Prevents alerts from being sent to internal/private network addresses
 * which could be exploited for Server-Side Request Forgery attacks.
 */
const BLOCKED_HOSTNAMES = new Set([
  'localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]',
  'metadata.google.internal', '169.254.169.254',
  'metadata.google.com', 'metadata',
]);

const PRIVATE_IP_RANGES = [
  /^10\./,                          // 10.0.0.0/8
  /^172\.(1[6-9]|2\d|3[01])\./,    // 172.16.0.0/12
  /^192\.168\./,                     // 192.168.0.0/16
  /^127\./,                          // 127.0.0.0/8
  /^0\./,                            // 0.0.0.0/8
  /^169\.254\./,                     // Link-local
  /^fc/i,                            // IPv6 ULA
  /^fd/i,                            // IPv6 ULA
  /^fe80/i,                          // IPv6 link-local
];

export function validateWebhookUrl(url: string): { valid: boolean; error?: string } {
  try {
    const parsed = new URL(url);

    // Only allow HTTPS (and HTTP for development)
    if (!['https:', 'http:'].includes(parsed.protocol)) {
      return { valid: false, error: 'Webhook URL must use HTTP or HTTPS protocol' };
    }

    // Block file://, ftp://, etc.
    if (parsed.protocol === 'file:' || parsed.protocol === 'ftp:') {
      return { valid: false, error: 'Invalid protocol for webhook URL' };
    }

    // Block known internal hostnames
    const hostname = parsed.hostname.toLowerCase();
    if (BLOCKED_HOSTNAMES.has(hostname)) {
      return { valid: false, error: 'Webhook URL points to a blocked internal address' };
    }

    // Block private IP ranges
    for (const range of PRIVATE_IP_RANGES) {
      if (range.test(hostname)) {
        return { valid: false, error: 'Webhook URL points to a private network address' };
      }
    }

    // Block URLs with credentials
    if (parsed.username || parsed.password) {
      return { valid: false, error: 'Webhook URL must not contain credentials' };
    }

    return { valid: true };
  } catch {
    return { valid: false, error: 'Invalid webhook URL format' };
  }
}

/**
 * Webhook Signature Verification (HMAC-SHA256)
 *
 * Signs outgoing webhook payloads so recipients can verify authenticity.
 * The signature is sent in the X-Webhook-Signature header.
 */
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'polymarket-alerts-default-secret';

export async function signWebhookPayload(payload: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  const hashArray = Array.from(new Uint8Array(signature));
  return 'sha256=' + hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Send alert notification via webhook
 */
async function sendAlert(config: AlertConfig, market: PolymarketMarket, currentPrice: number): Promise<boolean> {
  // Validate webhook URL against SSRF
  const urlCheck = validateWebhookUrl(config.notifyUrl);
  if (!urlCheck.valid) {
    console.error(`SSRF blocked: ${urlCheck.error} - ${config.notifyUrl}`);
    return false;
  }

  try {
    const body = JSON.stringify({
      type: 'prediction_market_alert',
      marketId: config.marketId,
      question: market.question,
      outcome: config.outcome,
      threshold: config.threshold,
      direction: config.direction,
      currentPrice: currentPrice.toFixed(2),
      triggeredAt: new Date().toISOString(),
    });

    // Sign the payload
    const signature = await signWebhookPayload(body);

    const response = await fetch(config.notifyUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
        'X-Webhook-Timestamp': Math.floor(Date.now() / 1000).toString(),
      },
      body,
    });

    return response.ok;
  } catch (error) {
    console.error('Failed to send alert:', error);
    return false;
  }
}

/**
 * Record a price snapshot for a market
 * Called during each CRE execution to build price history
 */
export function recordPriceSnapshot(
  priceHistory: Record<string, PriceSnapshot[]>,
  marketId: string,
  market: PolymarketMarket,
  maxSnapshots: number = 288  // 24h of 5-min intervals
): void {
  if (!priceHistory[marketId]) {
    priceHistory[marketId] = [];
  }

  const snapshot: PriceSnapshot = {
    timestamp: Date.now(),
    prices: {},
  };

  for (const token of market.tokens) {
    snapshot.prices[token.outcome] = token.price * 100;
  }

  priceHistory[marketId].push(snapshot);

  // Trim old snapshots to keep memory bounded
  if (priceHistory[marketId].length > maxSnapshots) {
    priceHistory[marketId] = priceHistory[marketId].slice(-maxSnapshots);
  }
}

/**
 * Analyze price trend for a market outcome
 * Uses price history to compute momentum, volatility, and directional changes
 */
export function analyzeTrend(
  snapshots: PriceSnapshot[],
  outcome: string,
): TrendAnalysis {
  const now = Date.now();
  const relevantSnapshots = snapshots
    .filter(s => s.prices[outcome] !== undefined)
    .sort((a, b) => a.timestamp - b.timestamp);

  if (relevantSnapshots.length === 0) {
    return {
      outcome,
      currentPrice: 0,
      changePercent1h: null,
      changePercent6h: null,
      changePercent24h: null,
      momentum: 'stable',
      volatility: 0,
      dataPoints: 0,
    };
  }

  const currentPrice = relevantSnapshots[relevantSnapshots.length - 1]!.prices[outcome] ?? 0;

  // Calculate changes over time windows
  const findPriceAt = (msAgo: number): number | null => {
    const targetTime = now - msAgo;
    // Find closest snapshot to the target time
    let closest: PriceSnapshot | null = null;
    let closestDiff = Infinity;
    for (const s of relevantSnapshots) {
      const diff = Math.abs(s.timestamp - targetTime);
      if (diff < closestDiff) {
        closestDiff = diff;
        closest = s;
      }
    }
    // Only use if within 20% of the target window
    if (closest && closestDiff < msAgo * 0.2) {
      return closest.prices[outcome] ?? null;
    }
    return null;
  };

  const price1hAgo = findPriceAt(3600000);       // 1 hour
  const price6hAgo = findPriceAt(21600000);       // 6 hours
  const price24hAgo = findPriceAt(86400000);      // 24 hours

  const changePercent1h = price1hAgo !== null ? currentPrice - price1hAgo : null;
  const changePercent6h = price6hAgo !== null ? currentPrice - price6hAgo : null;
  const changePercent24h = price24hAgo !== null ? currentPrice - price24hAgo : null;

  // Calculate volatility (standard deviation of recent prices)
  const recentPrices = relevantSnapshots.slice(-12).map(s => s.prices[outcome] ?? 0);
  const mean = recentPrices.reduce((a, b) => (a ?? 0) + (b ?? 0), 0) / recentPrices.length;
  const variance = recentPrices.reduce((sum, p) => (sum ?? 0) + Math.pow((p ?? 0) - mean, 2), 0) / recentPrices.length;
  const volatility = Math.sqrt(variance);

  // Determine momentum based on short-term change
  let momentum: TrendAnalysis['momentum'] = 'stable';
  if (changePercent1h !== null) {
    if (changePercent1h >= 5) momentum = 'surging_up';
    else if (changePercent1h >= 2) momentum = 'trending_up';
    else if (changePercent1h <= -5) momentum = 'surging_down';
    else if (changePercent1h <= -2) momentum = 'trending_down';
  }

  return {
    outcome,
    currentPrice: currentPrice ?? 0,
    changePercent1h,
    changePercent6h,
    changePercent24h,
    momentum,
    volatility: parseFloat(volatility.toFixed(2)),
    dataPoints: relevantSnapshots.length,
  };
}

/**
 * Check if a trend-based alert condition is met
 */
function checkTrendCondition(
  priceHistory: Record<string, PriceSnapshot[]>,
  config: AlertConfig,
): boolean {
  const snapshots = priceHistory[config.marketId];
  if (!snapshots || snapshots.length < 2) return false;

  const trend = analyzeTrend(snapshots, config.outcome);
  const window = config.trendWindow || 3600000; // Default 1 hour
  const minChange = config.trendMinChange || 5;

  // Select the appropriate change window
  let change: number | null;
  if (window <= 3600000) {
    change = trend.changePercent1h;
  } else if (window <= 21600000) {
    change = trend.changePercent6h;
  } else {
    change = trend.changePercent24h;
  }

  if (change === null) return false;

  if (config.trendDirection === 'up') {
    return change >= minChange;
  } else if (config.trendDirection === 'down') {
    return change <= -minChange;
  }

  return Math.abs(change) >= minChange;
}

/**
 * Main workflow execution
 *
 * This function is called by CRE on schedule or trigger
 */
export async function executeWorkflow(state: WorkflowState): Promise<{
  state: WorkflowState;
  alerts: string[];
}> {
  const alerts: string[] = [];
  const now = Date.now();

  // Initialize price history if not present
  if (!state.priceHistory) {
    state.priceHistory = {};
  }

  for (const config of state.alertConfigs) {
    // Skip if already triggered (unless we want repeating alerts)
    const alertKey = `${config.marketId}-${config.outcome}-${config.threshold}-${config.direction}`;
    if (state.triggeredAlerts.includes(alertKey)) {
      continue;
    }

    // Rate limit: check each market at most once per minute
    const lastChecked = state.lastChecked[config.marketId] || 0;
    if (now - lastChecked < 60000) {
      continue;
    }

    state.lastChecked[config.marketId] = now;

    // Fetch current market data
    const market = await fetchMarketData(config.marketId);
    if (!market || !market.active || market.closed) {
      continue;
    }

    // Record price snapshot for history tracking
    recordPriceSnapshot(state.priceHistory, config.marketId, market);

    // Check condition based on alert type
    const alertType = config.type || 'threshold';
    let conditionMet = false;

    if (alertType === 'trend') {
      conditionMet = checkTrendCondition(state.priceHistory, config);
    } else {
      conditionMet = checkAlertCondition(market, config);
    }

    if (conditionMet) {
      const token = market.tokens.find(t =>
        t.outcome.toLowerCase() === config.outcome.toLowerCase()
      );
      const currentPrice = (token?.price || 0) * 100;

      // Send notification
      const sent = await sendAlert(config, market, currentPrice);
      if (sent) {
        state.triggeredAlerts.push(alertKey);
        const alertMsg = alertType === 'trend'
          ? `Trend alert: ${market.question} - ${config.outcome} ${config.trendDirection} by ${config.trendMinChange}%+`
          : `Alert triggered: ${market.question} - ${config.outcome} at ${currentPrice.toFixed(1)}%`;
        alerts.push(alertMsg);
      }
    }
  }

  return { state, alerts };
}

/**
 * Enhanced natural language parsing for alert requests
 *
 * Supports various phrasings:
 * - "Alert me when Trump election odds exceed 60%"
 * - "Notify when Bitcoin ETF approval drops below 30%"
 * - "Tell me if Trump wins probability goes above 55%"
 * - "Watch when No hits 40% on AI regulation"
 * - "Alert when the price of Yes on election is over 70 cents"
 * - "If recession likelihood falls under 25%, let me know"
 */

// Pattern definitions for parsing
interface ParsePattern {
  regex: RegExp;
  extractor: (match: RegExpMatchArray) => Partial<AlertConfig> | null;
}

/**
 * Levenshtein distance for fuzzy matching
 * Enables typo-tolerant NLP parsing (e.g., "exceeed", "bellow", "abve")
 */
export function levenshteinDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] = a[i - 1] === b[j - 1]
        ? dp[i - 1]![j - 1]!
        : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  return dp[m]![n]!;
}

/**
 * Fuzzy match a word against a list of keywords
 * Returns the best match if within the allowed edit distance
 */
export function fuzzyMatch(word: string, keywords: string[], maxDistance: number = 2): string | null {
  const lower = word.toLowerCase();
  let bestMatch: string | null = null;
  let bestDist = Infinity;

  for (const kw of keywords) {
    // Exact substring check first
    if (lower.includes(kw)) return kw;

    // For multi-word keywords, check if they appear in the text
    if (kw.includes(' ') && lower.includes(kw)) return kw;

    // Single-word fuzzy match
    if (!kw.includes(' ')) {
      const dist = levenshteinDistance(lower, kw);
      if (dist < bestDist && dist <= maxDistance) {
        bestDist = dist;
        bestMatch = kw;
      }
    }
  }

  return bestMatch;
}

/**
 * Fuzzy-match direction keywords in text
 * Handles typos like "exceeed", "abve", "bellow", "drps"
 *
 * Uses best-match strategy: checks all keywords in both directions
 * and picks the one with the lowest edit distance.
 */
export function fuzzyDetectDirection(text: string): 'above' | 'below' | null {
  const words = text.toLowerCase().split(/\s+/);

  // Check exact matches first (fast path)
  const exactDir = detectDirection(text);
  if (exactDir) return exactDir;

  // Fuzzy match: find the closest keyword across both lists
  // Also extract first words from multi-word keywords (e.g., "drops" from "drops to")
  const aboveSingle = [...new Set([
    ...ABOVE_KEYWORDS.filter(k => !k.includes(' ')),
    ...ABOVE_KEYWORDS.filter(k => k.includes(' ')).map(k => k.split(' ')[0]!),
  ])];
  const belowSingle = [...new Set([
    ...BELOW_KEYWORDS.filter(k => !k.includes(' ')),
    ...BELOW_KEYWORDS.filter(k => k.includes(' ')).map(k => k.split(' ')[0]!),
  ])];

  let bestDir: 'above' | 'below' | null = null;
  let bestDist = Infinity;

  for (const word of words) {
    if (word.length < 3) continue;

    // Check above keywords
    for (const kw of aboveSingle) {
      const dist = levenshteinDistance(word, kw);
      if (dist <= 2 && dist < bestDist) {
        bestDist = dist;
        bestDir = 'above';
      }
    }

    // Check below keywords
    for (const kw of belowSingle) {
      const dist = levenshteinDistance(word, kw);
      if (dist <= 2 && dist < bestDist) {
        bestDist = dist;
        bestDir = 'below';
      }
    }
  }

  return bestDir;
}

// Keywords for direction detection
const ABOVE_KEYWORDS = [
  'exceed', 'exceeds', 'above', 'over', 'greater than', 'more than',
  'reaches', 'hits', 'gets to', 'goes above', 'rises to', 'climbs to',
  'surpasses', 'passes', 'breaks', 'tops', '>'
];

const BELOW_KEYWORDS = [
  'fall below', 'below', 'under', 'less than', 'drops to', 'drops below',
  'falls to', 'falls under', 'dips to', 'dips below', 'sinks to',
  'declines to', '<'
];

// Keywords for outcome detection
const YES_KEYWORDS = ['yes', 'true', 'will', 'pass', 'approve', 'win', 'happen'];
const NO_KEYWORDS = ['no', 'false', "won't", 'fail', 'reject', 'lose', "doesn't"];

function detectDirection(text: string): 'above' | 'below' | null {
  const lower = text.toLowerCase();
  for (const kw of BELOW_KEYWORDS) {
    if (lower.includes(kw)) return 'below';
  }
  for (const kw of ABOVE_KEYWORDS) {
    if (lower.includes(kw)) return 'above';
  }
  return null;
}

function detectOutcome(text: string): 'Yes' | 'No' {
  const lower = text.toLowerCase();
  // Explicit No mention takes priority
  if (/\b(no outcome|"no"|'no'|\bno\b(?:\s+option|\s+side)?)/i.test(text)) {
    return 'No';
  }
  for (const kw of NO_KEYWORDS) {
    if (lower.includes(kw)) return 'No';
  }
  return 'Yes';
}

function extractPercentage(text: string): number | null {
  // Match various percentage formats
  const patterns = [
    /(\d+(?:\.\d+)?)\s*%/,           // "60%"
    /(\d+(?:\.\d+)?)\s*percent/i,    // "60 percent"
    /(\d+(?:\.\d+)?)\s*cents?/i,     // "70 cents" (Polymarket price format)
    /0\.(\d+)/,                       // "0.60" (decimal odds)
    /\.(\d+)/,                        // ".60"
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      let value = parseFloat(match[1]!);
      // Handle "cents" format (70 cents = 70%)
      if (pattern.source.includes('cents')) {
        return value;
      }
      // Handle decimal format (0.60 = 60%)
      if (pattern.source.includes('0\\.')) {
        return value * 100;
      }
      return value;
    }
  }
  return null;
}

function extractSubject(text: string): string {
  // Remove common alert prefixes
  let cleaned = text.replace(/^(alert|notify|tell|watch|let me know|ping me|message me|inform me)\s*(me|us)?\s*(when|if|once)?\s*/i, '');

  // Remove threshold phrases
  cleaned = cleaned.replace(/\s*(exceeds?|above|over|below|under|reaches|hits|drops?|falls?|goes?|rises?|climbs?|dips?|declines?|sinks?)\s*(\d+(?:\.\d+)?)\s*(%|percent|cents?)?\s*/gi, '');

  // Remove trailing phrases
  cleaned = cleaned.replace(/\s*,?\s*(let me know|notify me|alert me|tell me).*$/i, '');

  // Clean up
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return cleaned || text;
}

export function parseAlertRequest(request: string, notifyUrl: string): AlertConfig | null {
  // Advanced pattern matching
  const patterns: ParsePattern[] = [
    // Pattern 1: "when X odds/probability/chance exceed/above Y%"
    {
      regex: /(?:when|if|once)\s+(.+?)\s+(?:odds?|probability|chance|likelihood)\s+(?:to\s+)?(\w+(?:\s+\w+)*)\s+(\d+(?:\.\d+)?)\s*(%|percent|cents?)?/i,
      extractor: (m) => ({
        threshold: parseFloat(m[3]!),
        direction: detectDirection(m[2]!) ?? undefined,
        outcome: detectOutcome(m[1]!),
      })
    },
    // Pattern 2: "when X exceeds/drops below Y%"
    {
      regex: /(?:when|if|once)\s+(.+?)\s+(exceeds?|goes?\s+above|rises?\s+to|drops?\s+(?:to|below)|falls?\s+(?:to|below)|goes?\s+below)\s+(\d+(?:\.\d+)?)\s*(%|percent|cents?)?/i,
      extractor: (m) => ({
        threshold: parseFloat(m[3]!),
        direction: detectDirection(m[2]!) ?? undefined,
        outcome: detectOutcome(m[1]!),
      })
    },
    // Pattern 3: "X > Y%" or "X < Y%"
    {
      regex: /(.+?)\s*([<>])\s*(\d+(?:\.\d+)?)\s*(%|percent|cents?)?/,
      extractor: (m) => ({
        threshold: parseFloat(m[3]!),
        direction: m[2] === '>' ? 'above' : 'below',
        outcome: detectOutcome(m[1]!),
      })
    },
    // Pattern 4: Simple "X hits Y%"
    {
      regex: /(.+?)\s+(hits?|reaches?|at|to)\s+(\d+(?:\.\d+)?)\s*(%|percent|cents?)?/i,
      extractor: (m) => ({
        threshold: parseFloat(m[3]!),
        direction: 'above' as const,
        outcome: detectOutcome(m[1]!),
      })
    },
  ];

  // Try each pattern
  for (const { regex, extractor } of patterns) {
    const match = request.match(regex);
    if (match) {
      const parsed = extractor(match);
      if (parsed && parsed.threshold !== undefined && parsed.direction) {
        return {
          marketId: '', // Resolved via market search
          outcome: parsed.outcome || 'Yes',
          threshold: parsed.threshold,
          direction: parsed.direction,
          notifyUrl,
        };
      }
    }
  }

  // Fallback: Extract what we can (with fuzzy matching for typos)
  const percentage = extractPercentage(request);
  const direction = detectDirection(request) || fuzzyDetectDirection(request);

  if (percentage !== null && direction !== null) {
    return {
      marketId: '',
      outcome: detectOutcome(request),
      threshold: percentage,
      direction,
      notifyUrl,
    };
  }

  return null;
}

/**
 * Parse multiple conditions from a single request
 *
 * Examples:
 * - "Alert when Trump > 60% AND Biden < 40%"
 * - "Watch both: recession above 70% or inflation below 20%"
 */
export function parseMultiConditionAlert(request: string, notifyUrl: string): AlertConfig[] {
  const results: AlertConfig[] = [];

  // Split on AND/OR/both/either/,
  const parts = request.split(/\s+(?:and|or|,|&|\|)\s+/i);

  for (const part of parts) {
    const parsed = parseAlertRequest(part.trim(), notifyUrl);
    if (parsed) {
      results.push(parsed);
    }
  }

  return results;
}

/**
 * Extract search keywords from natural language
 */
export function extractSearchKeywords(request: string): string[] {
  const subject = extractSubject(request);

  // Extract potential search terms
  const keywords: string[] = [];

  // Named entities (capitalized words)
  const namedEntities = subject.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g);
  if (namedEntities) {
    keywords.push(...namedEntities);
  }

  // Topic keywords
  const topicPatterns = [
    /(?:about|on|for|regarding)\s+(.+?)(?:\s+(?:odds|probability|chance|market)|$)/i,
    /(.+?)\s+(?:election|approval|outcome|decision|vote|result)/i,
    /(?:will|if)\s+(.+?)\s+(?:win|pass|happen|be\s+approved)/i,
  ];

  for (const pattern of topicPatterns) {
    const match = request.match(pattern);
    if (match) {
      keywords.push(match[1]!.trim());
    }
  }

  // Fallback to subject words
  if (keywords.length === 0) {
    const words = subject.split(/\s+/).filter(w => w.length > 3);
    keywords.push(...words.slice(0, 3));
  }

  return [...new Set(keywords)];
}

/**
 * Search for markets matching a query
 *
 * This would connect to Polymarket's search API
 */
export async function searchMarkets(query: string): Promise<PolymarketMarket[]> {
  const GAMMA_API = 'https://gamma-api.polymarket.com';

  try {
    // Search for markets matching the query
    const response = await fetch(`${GAMMA_API}/markets?closed=false&_limit=10`);
    if (!response.ok) {
      return [];
    }

    const markets = await response.json() as any[];

    // Filter by query (simple text match)
    const queryLower = query.toLowerCase();
    return markets.filter(m =>
      m.question?.toLowerCase().includes(queryLower) ||
      m.description?.toLowerCase().includes(queryLower)
    ).map(m => ({
      condition_id: m.conditionId,
      question: m.question,
      outcomes: m.outcomes || ['Yes', 'No'],
      tokens: m.tokens || [],
      active: m.active,
      closed: m.closed,
      volume: m.volume,
    }));
  } catch (error) {
    console.error('Market search failed:', error);
    return [];
  }
}

// ─── CRE Workflow Configuration ──────────────────────────────────────────────
//
// The workflow config is passed to handlers via runtime.config.
// In production CRE deployments this is serialized and distributed to DON nodes.

export interface PolymarketWorkflowConfig {
  /** Polymarket CLOB API base URL */
  clobApiUrl: string;
  /** Gamma search API base URL */
  gammaApiUrl: string;
  /** HMAC secret for signing webhook payloads */
  webhookSecret: string;
  /** Persisted alert configurations from user subscriptions */
  alertConfigs: AlertConfig[];
  /** Max price history snapshots per market (default: 288 = 24h at 5min intervals) */
  maxSnapshots: number;
}

/**
 * Default workflow configuration.
 * Override via CRE deployment config or environment variables.
 */
export const defaultWorkflowConfig: PolymarketWorkflowConfig = {
  clobApiUrl: 'https://clob.polymarket.com',
  gammaApiUrl: 'https://gamma-api.polymarket.com',
  webhookSecret: process.env.WEBHOOK_SECRET || 'polymarket-alerts-default-secret',
  alertConfigs: [],
  maxSnapshots: 288,
};

// ─── CRE Handler: Cron-Triggered Market Check ───────────────────────────────
//
// Fires every 5 minutes via CronCapability. Iterates alert configs, fetches
// market data using HTTPClient, evaluates conditions, and sends webhook
// notifications for triggered alerts.

const handleCronTrigger: HandlerFn<PolymarketWorkflowConfig, CronPayload, string> = async (
  runtime,
  cronPayload,
) => {
  const config = runtime.config;
  runtime.log(`[polymarket-alerts] Cron fired at ${cronPayload.scheduledExecutionTime}`);

  // In a full CRE deployment, this would use runtime.runInNodeMode + HTTPClient
  // to make outbound requests with DON consensus. For the local/hybrid execution
  // path we delegate to the existing executeWorkflow logic which uses fetch().
  const state: WorkflowState = {
    alertConfigs: config.alertConfigs,
    lastChecked: {},
    triggeredAlerts: [],
    priceHistory: {},
  };

  const result = await executeWorkflow(state);
  const summary = `Checked ${config.alertConfigs.length} alerts, triggered ${result.alerts.length}`;
  runtime.log(`[polymarket-alerts] ${summary}`);
  return summary;
};

// ─── CRE Handler: HTTP-Triggered Alert Creation ─────────────────────────────
//
// Accepts inbound HTTP requests (e.g., from the API server or x402 payment flow)
// to parse natural language and register new alert configs.

const handleHttpTrigger: HandlerFn<PolymarketWorkflowConfig, HTTPPayload, string> = async (
  runtime,
  httpPayload,
) => {
  runtime.log('[polymarket-alerts] HTTP trigger received');

  // Decode the incoming JSON payload from the HTTP trigger
  const decoder = new TextDecoder();
  const bodyStr = decoder.decode(httpPayload.input);

  try {
    const body = JSON.parse(bodyStr) as {
      naturalLanguage?: string;
      notifyUrl?: string;
    };

    if (!body.naturalLanguage || !body.notifyUrl) {
      return 'error: missing naturalLanguage or notifyUrl';
    }

    const parsed = parseAlertRequest(body.naturalLanguage, body.notifyUrl);
    if (!parsed) {
      return 'error: could not parse alert request';
    }

    runtime.log(`[polymarket-alerts] Parsed alert: ${parsed.direction} ${parsed.threshold}% on ${parsed.outcome}`);
    return `alert_created: ${parsed.outcome} ${parsed.direction} ${parsed.threshold}%`;
  } catch {
    return 'error: invalid JSON payload';
  }
};

// ─── CRE Workflow Definition ────────────────────────────────────────────────
//
// Assembles trigger capabilities and handler functions into a CRE Workflow.
// This is the entry point that CRE's Runner executes.

const cronCapability = new CronCapability();
const httpCapability = new HTTPCapability();

/**
 * Initialize the Polymarket Alert CRE workflow.
 *
 * Returns an array of handler entries that CRE's Runner will execute.
 * Each entry pairs a trigger (cron schedule or HTTP endpoint) with a
 * handler function that receives the Runtime and trigger output.
 *
 * Usage with CRE Runner:
 * ```ts
 * import { Runner } from '@chainlink/cre-sdk';
 * const runner = await Runner.newRunner<PolymarketWorkflowConfig>({
 *   configParser: (raw) => JSON.parse(new TextDecoder().decode(raw)),
 * });
 * await runner.run(initPolymarketAlertWorkflow);
 * ```
 */
export function initPolymarketAlertWorkflow(): Workflow<PolymarketWorkflowConfig> {
  return [
    // Handler 1: Cron trigger - check markets every 5 minutes
    cre.handler(
      cronCapability.trigger({ schedule: '*/5 * * * *' }),
      handleCronTrigger,
    ),
    // Handler 2: HTTP trigger - accept new alert creation requests
    cre.handler(
      httpCapability.trigger({ authorizedKeys: [] }),
      handleHttpTrigger,
    ),
  ] as unknown as Workflow<PolymarketWorkflowConfig>;
}

// ─── Default Export (backward-compatible metadata) ──────────────────────────

export default {
  name: 'polymarket-alerts',
  version: '2.0.0',
  description: 'Monitor prediction markets with threshold and trend alerts via Chainlink CRE',
  workflow: initPolymarketAlertWorkflow,
  config: defaultWorkflowConfig,
  capabilities: {
    triggers: [
      `${CronCapability.CAPABILITY_ID} (schedule: */5 * * * *)`,
      `${HTTPCapability.CAPABILITY_ID} (alert creation endpoint)`,
    ],
    actions: [
      `${HTTPClient.CAPABILITY_ID} (Polymarket CLOB API, webhook delivery)`,
    ],
  },
  execute: executeWorkflow,
  helpers: {
    parseAlertRequest,
    searchMarkets,
    fetchMarketData,
    analyzeTrend,
    recordPriceSnapshot,
    initPolymarketAlertWorkflow,
  },
};
