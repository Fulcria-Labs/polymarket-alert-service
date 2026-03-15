/**
 * MarketCorrelation Module — Advanced Cross-Market Analytics
 *
 * Extends the Polymarket Alert Service with deep analytical capabilities:
 *
 * 1. Multi-market correlation analysis with time-windowed Pearson coefficients
 * 2. Cross-market arbitrage opportunity detection with confidence scoring
 * 3. Conditional probability estimation (P(B|A) via Bayesian inference on price data)
 * 4. Market maker activity pattern detection (spread tightening, accumulation, distribution)
 * 5. Correlation matrix generation with clustering and regime detection
 *
 * All functions are pure (no side effects) and operate on PriceSnapshot[] data
 * produced by the CRE workflow's periodic polling.
 *
 * Designed for integration with Chainlink CRE: the workflow can call these
 * functions during each cron cycle to produce analytics that are then
 * served via the API or emitted as webhook alerts.
 */

import type { PriceSnapshot } from './polymarket-alert-workflow';
import { pearsonCorrelation, classifyCorrelation } from './portfolio';
import type { CorrelationPair } from './portfolio';

// ─── Types ───────────────────────────────────────────────────────────────────

/** A market with its price series extracted for a specific outcome */
export interface MarketSeries {
  marketId: string;
  outcome: string;
  prices: number[];
  timestamps: number[];
}

/** Result of a rolling-window correlation analysis */
export interface RollingCorrelation {
  marketA: string;
  marketB: string;
  windowSize: number;
  correlations: { timestamp: number; correlation: number }[];
  currentCorrelation: number;
  trendDirection: 'strengthening' | 'weakening' | 'stable';
  regimeChanges: { timestamp: number; from: string; to: string }[];
}

/** Conditional probability estimate: P(B|A) */
export interface ConditionalProbability {
  eventA: { marketId: string; outcome: string; threshold: number; direction: 'above' | 'below' };
  eventB: { marketId: string; outcome: string };
  /** Estimated P(B|A) based on historical co-movement */
  probability: number;
  /** Number of historical windows where A's condition was met */
  sampleSize: number;
  /** Standard error of the estimate */
  standardError: number;
  /** 95% confidence interval [lower, upper] */
  confidenceInterval: [number, number];
  /** Whether the estimate is statistically reliable (sampleSize >= 10) */
  reliable: boolean;
}

/** Detected arbitrage opportunity across related markets */
export interface CrossMarketArbitrageOpportunity {
  markets: { marketId: string; outcome: string; price: number }[];
  /** Type of relationship detected */
  relationship: 'mutually_exclusive' | 'subset' | 'complementary' | 'correlated';
  /** Sum of prices (for mutually exclusive, should be <= 100) */
  combinedPrice: number;
  /** Expected combined price based on relationship type */
  expectedMax: number;
  /** Profit potential as percentage points */
  profitPotential: number;
  /** Confidence in the opportunity */
  confidence: 'high' | 'medium' | 'low';
  /** Human-readable description of the opportunity */
  description: string;
}

/** Market maker activity signal */
export interface MarketMakerSignal {
  marketId: string;
  /** Type of market maker behavior detected */
  pattern: 'accumulation' | 'distribution' | 'spread_tightening' | 'spread_widening' | 'mean_reversion' | 'momentum_ignition';
  /** Strength of the signal 0-1 */
  strength: number;
  /** Supporting evidence */
  evidence: string;
  /** Time window over which the pattern was observed */
  windowMs: number;
  /** Whether this is actionable */
  actionable: boolean;
}

/** Correlation matrix with clustering metadata */
export interface EnhancedCorrelationMatrix {
  markets: string[];
  outcome: string;
  matrix: number[][];
  pairs: CorrelationPair[];
  /** Groups of highly correlated markets (clusters) */
  clusters: { markets: string[]; avgCorrelation: number; label: string }[];
  /** Average correlation across all pairs */
  averageCorrelation: number;
  /** Markets that behave independently (|r| < 0.2 with all others) */
  independentMarkets: string[];
  /** Timestamp when analysis was performed */
  analyzedAt: number;
}

/** Market regime (bull/bear/ranging) based on price trends */
export interface MarketRegime {
  marketId: string;
  outcome: string;
  regime: 'bullish' | 'bearish' | 'ranging' | 'volatile';
  confidence: number;
  trendStrength: number;
  /** Average return over the window */
  avgReturn: number;
  /** Annualized volatility */
  volatility: number;
}

// ─── Price Series Extraction ─────────────────────────────────────────────────

/**
 * Extract a clean price series for a specific market and outcome from
 * PriceSnapshot history. Filters out snapshots missing the outcome.
 */
export function extractSeries(
  priceHistory: Record<string, PriceSnapshot[]>,
  marketId: string,
  outcome: string = 'Yes',
): MarketSeries {
  const snapshots = priceHistory[marketId] || [];
  const filtered = snapshots
    .filter(s => s.prices[outcome] !== undefined)
    .sort((a, b) => a.timestamp - b.timestamp);

  return {
    marketId,
    outcome,
    prices: filtered.map(s => s.prices[outcome]!),
    timestamps: filtered.map(s => s.timestamp),
  };
}

/**
 * Align two series by timestamp, returning only overlapping time windows.
 * Uses nearest-neighbor interpolation within a tolerance window.
 */
export function alignSeries(
  seriesA: MarketSeries,
  seriesB: MarketSeries,
  toleranceMs: number = 60000, // 1 minute default tolerance
): { pricesA: number[]; pricesB: number[]; timestamps: number[] } {
  const pricesA: number[] = [];
  const pricesB: number[] = [];
  const timestamps: number[] = [];

  let j = 0;
  for (let i = 0; i < seriesA.timestamps.length; i++) {
    const tA = seriesA.timestamps[i]!;

    // Find closest timestamp in seriesB
    while (j < seriesB.timestamps.length - 1 &&
           Math.abs(seriesB.timestamps[j + 1]! - tA) < Math.abs(seriesB.timestamps[j]! - tA)) {
      j++;
    }

    if (j < seriesB.timestamps.length && Math.abs(seriesB.timestamps[j]! - tA) <= toleranceMs) {
      pricesA.push(seriesA.prices[i]!);
      pricesB.push(seriesB.prices[j]!);
      timestamps.push(tA);
    }
  }

  return { pricesA, pricesB, timestamps };
}

// ─── Rolling Correlation ─────────────────────────────────────────────────────

/**
 * Compute rolling-window Pearson correlations between two markets.
 * Returns correlation at each step along with trend detection and regime changes.
 *
 * @param windowSize Number of data points per rolling window (minimum 5)
 * @param stepSize Number of data points to advance per step (default 1)
 */
export function computeRollingCorrelation(
  priceHistory: Record<string, PriceSnapshot[]>,
  marketIdA: string,
  marketIdB: string,
  outcome: string = 'Yes',
  windowSize: number = 20,
  stepSize: number = 1,
): RollingCorrelation {
  const seriesA = extractSeries(priceHistory, marketIdA, outcome);
  const seriesB = extractSeries(priceHistory, marketIdB, outcome);
  const aligned = alignSeries(seriesA, seriesB);

  const effectiveWindow = Math.max(5, Math.min(windowSize, aligned.pricesA.length));
  const correlations: { timestamp: number; correlation: number }[] = [];
  const regimeChanges: RollingCorrelation['regimeChanges'] = [];
  let prevClassification = '';

  for (let i = effectiveWindow - 1; i < aligned.pricesA.length; i += stepSize) {
    const startIdx = i - effectiveWindow + 1;
    const windowA = aligned.pricesA.slice(startIdx, i + 1);
    const windowB = aligned.pricesB.slice(startIdx, i + 1);
    const r = pearsonCorrelation(windowA, windowB);
    const classification = classifyCorrelation(r);

    correlations.push({
      timestamp: aligned.timestamps[i]!,
      correlation: r,
    });

    if (prevClassification && classification !== prevClassification) {
      regimeChanges.push({
        timestamp: aligned.timestamps[i]!,
        from: prevClassification,
        to: classification,
      });
    }
    prevClassification = classification;
  }

  // Determine trend direction from last few correlations
  let trendDirection: RollingCorrelation['trendDirection'] = 'stable';
  if (correlations.length >= 3) {
    const recent = correlations.slice(-3);
    const diffs = recent.map((c, i) => i > 0 ? c.correlation - recent[i - 1]!.correlation : 0).slice(1);
    const avgDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    if (avgDiff > 0.05) trendDirection = 'strengthening';
    else if (avgDiff < -0.05) trendDirection = 'weakening';
  }

  return {
    marketA: marketIdA,
    marketB: marketIdB,
    windowSize: effectiveWindow,
    correlations,
    currentCorrelation: correlations.length > 0 ? correlations[correlations.length - 1]!.correlation : 0,
    trendDirection,
    regimeChanges,
  };
}

// ─── Conditional Probability Estimation ──────────────────────────────────────

/**
 * Estimate P(B_price | A condition met) using historical price data.
 *
 * For each time window where event A's condition is satisfied (e.g., market A > 60%),
 * record the concurrent price of market B. The average gives an estimate of P(B|A).
 *
 * This is a frequentist approach: we look at all historical moments when A's
 * condition was met and compute the average B price at those moments.
 */
export function estimateConditionalProbability(
  priceHistory: Record<string, PriceSnapshot[]>,
  eventA: ConditionalProbability['eventA'],
  eventB: ConditionalProbability['eventB'],
): ConditionalProbability {
  const seriesA = extractSeries(priceHistory, eventA.marketId, eventA.outcome);
  const seriesB = extractSeries(priceHistory, eventB.marketId, eventB.outcome);
  const aligned = alignSeries(
    seriesA,
    seriesB,
    300000, // 5 minute tolerance for CRE polling interval
  );

  // Find all timestamps where A's condition is met
  const bValuesWhenAMet: number[] = [];

  for (let i = 0; i < aligned.pricesA.length; i++) {
    const aPrice = aligned.pricesA[i]!;
    const conditionMet = eventA.direction === 'above'
      ? aPrice >= eventA.threshold
      : aPrice <= eventA.threshold;

    if (conditionMet) {
      bValuesWhenAMet.push(aligned.pricesB[i]!);
    }
  }

  if (bValuesWhenAMet.length === 0) {
    return {
      eventA,
      eventB,
      probability: 0,
      sampleSize: 0,
      standardError: 0,
      confidenceInterval: [0, 0],
      reliable: false,
    };
  }

  // Mean B price when A condition is met
  const mean = bValuesWhenAMet.reduce((a, b) => a + b, 0) / bValuesWhenAMet.length;

  // Standard deviation
  const variance = bValuesWhenAMet.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / bValuesWhenAMet.length;
  const stdDev = Math.sqrt(variance);

  // Standard error of the mean
  const standardError = bValuesWhenAMet.length > 1
    ? stdDev / Math.sqrt(bValuesWhenAMet.length)
    : 0;

  // 95% CI using z=1.96
  const z = 1.96;
  const lower = Math.max(0, mean - z * standardError);
  const upper = Math.min(100, mean + z * standardError);

  // Normalize to 0-100 probability scale
  const probability = Math.max(0, Math.min(100, parseFloat(mean.toFixed(2))));

  return {
    eventA,
    eventB,
    probability,
    sampleSize: bValuesWhenAMet.length,
    standardError: parseFloat(standardError.toFixed(4)),
    confidenceInterval: [
      parseFloat(lower.toFixed(2)),
      parseFloat(upper.toFixed(2)),
    ],
    reliable: bValuesWhenAMet.length >= 10,
  };
}

/**
 * Compute a matrix of conditional probabilities: for each pair (A, B),
 * estimate P(B > 50% | A > threshold).
 */
export function conditionalProbabilityMatrix(
  priceHistory: Record<string, PriceSnapshot[]>,
  marketIds: string[],
  outcome: string = 'Yes',
  threshold: number = 50,
): { matrix: number[][]; markets: string[]; sampleSizes: number[][] } {
  const n = marketIds.length;
  const matrix: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
  const sampleSizes: number[][] = Array.from({ length: n }, () => Array(n).fill(0));

  for (let i = 0; i < n; i++) {
    matrix[i]![i] = 100; // P(A|A) = 100%
    sampleSizes[i]![i] = -1; // Self-reference marker

    for (let j = 0; j < n; j++) {
      if (i === j) continue;

      const result = estimateConditionalProbability(
        priceHistory,
        {
          marketId: marketIds[i]!,
          outcome,
          threshold,
          direction: 'above',
        },
        {
          marketId: marketIds[j]!,
          outcome,
        },
      );

      matrix[i]![j] = result.probability;
      sampleSizes[i]![j] = result.sampleSize;
    }
  }

  return { matrix, markets: marketIds, sampleSizes };
}

// ─── Multi-Market Arbitrage Detection ────────────────────────────────────────

/**
 * Detect arbitrage opportunities across a set of markets that represent
 * mutually exclusive outcomes (e.g., "Who will win the election?" with
 * separate markets for each candidate).
 *
 * For mutually exclusive events, the sum of Yes probabilities should be <= 100%.
 * If it exceeds 100%, there's a risk-free arbitrage by selling all outcomes.
 */
export function detectMutuallyExclusiveArbitrage(
  markets: { marketId: string; outcome: string; price: number; label: string }[],
): CrossMarketArbitrageOpportunity | null {
  if (markets.length < 2) return null;

  const combinedPrice = markets.reduce((sum, m) => sum + m.price, 0);
  const expectedMax = 100;
  const deviation = combinedPrice - expectedMax;

  if (deviation <= 2) return null; // No meaningful opportunity

  const profitPotential = parseFloat(deviation.toFixed(2));
  let confidence: CrossMarketArbitrageOpportunity['confidence'];
  if (deviation >= 15) confidence = 'high';
  else if (deviation >= 7) confidence = 'medium';
  else confidence = 'low';

  const labels = markets.map(m => m.label || m.marketId).join(', ');

  return {
    markets: markets.map(m => ({ marketId: m.marketId, outcome: m.outcome, price: m.price })),
    relationship: 'mutually_exclusive',
    combinedPrice: parseFloat(combinedPrice.toFixed(2)),
    expectedMax,
    profitPotential,
    confidence,
    description: `Mutually exclusive markets [${labels}] sum to ${combinedPrice.toFixed(1)}%, ` +
      `${deviation.toFixed(1)} points above the theoretical maximum of 100%. ` +
      `Sell all outcomes for a risk-free profit of ~${deviation.toFixed(1)}%.`,
  };
}

/**
 * Detect subset arbitrage: if event A implies event B, then P(A) <= P(B).
 * If P(A) > P(B), there's a mispricing.
 *
 * Example: "Trump wins presidency" implies "Republican wins presidency",
 * so P(Trump) should be <= P(Republican).
 */
export function detectSubsetArbitrage(
  subsetMarket: { marketId: string; outcome: string; price: number; label: string },
  supersetMarket: { marketId: string; outcome: string; price: number; label: string },
): CrossMarketArbitrageOpportunity | null {
  // Subset price should be <= superset price
  const deviation = subsetMarket.price - supersetMarket.price;

  if (deviation <= 2) return null; // Within noise threshold

  const profitPotential = parseFloat(deviation.toFixed(2));
  let confidence: CrossMarketArbitrageOpportunity['confidence'];
  if (deviation >= 10) confidence = 'high';
  else if (deviation >= 5) confidence = 'medium';
  else confidence = 'low';

  return {
    markets: [
      { marketId: subsetMarket.marketId, outcome: subsetMarket.outcome, price: subsetMarket.price },
      { marketId: supersetMarket.marketId, outcome: supersetMarket.outcome, price: supersetMarket.price },
    ],
    relationship: 'subset',
    combinedPrice: subsetMarket.price,
    expectedMax: supersetMarket.price,
    profitPotential,
    confidence,
    description: `"${subsetMarket.label}" (${subsetMarket.price.toFixed(1)}%) implies ` +
      `"${supersetMarket.label}" (${supersetMarket.price.toFixed(1)}%), ` +
      `but the subset is ${deviation.toFixed(1)} points higher. ` +
      `Buy "${supersetMarket.label}" and sell "${subsetMarket.label}" for ~${deviation.toFixed(1)}% profit.`,
  };
}

/**
 * Scan a set of markets for all types of cross-market arbitrage opportunities.
 * Combines mutually exclusive detection with pairwise correlation-based analysis.
 */
export function scanCrossMarketArbitrage(
  markets: { marketId: string; outcome: string; price: number; label: string }[],
  priceHistory: Record<string, PriceSnapshot[]>,
  outcome: string = 'Yes',
): CrossMarketArbitrageOpportunity[] {
  const opportunities: CrossMarketArbitrageOpportunity[] = [];

  // Check if the whole set is mutually exclusive
  const meArb = detectMutuallyExclusiveArbitrage(markets);
  if (meArb) opportunities.push(meArb);

  // Check all pairs for correlated arbitrage
  for (let i = 0; i < markets.length; i++) {
    for (let j = i + 1; j < markets.length; j++) {
      const a = markets[i]!;
      const b = markets[j]!;

      // Complementary check: if combined > 100 for Yes prices on related markets
      const combined = a.price + b.price;
      if (Math.abs(combined - 100) > 5) {
        const deviation = Math.abs(combined - 100);
        let confidence: CrossMarketArbitrageOpportunity['confidence'];
        if (deviation >= 15) confidence = 'high';
        else if (deviation >= 8) confidence = 'medium';
        else confidence = 'low';

        const direction = combined > 100 ? 'overpriced' : 'underpriced';

        opportunities.push({
          markets: [
            { marketId: a.marketId, outcome: a.outcome, price: a.price },
            { marketId: b.marketId, outcome: b.outcome, price: b.price },
          ],
          relationship: 'complementary',
          combinedPrice: parseFloat(combined.toFixed(2)),
          expectedMax: 100,
          profitPotential: parseFloat(deviation.toFixed(2)),
          confidence,
          description: `"${a.label}" + "${b.label}" combined at ${combined.toFixed(1)}% ` +
            `(${direction}). Expected ~100% for complementary events.`,
        });
      }
    }
  }

  // Sort by profit potential descending
  opportunities.sort((a, b) => b.profitPotential - a.profitPotential);
  return opportunities;
}

// ─── Market Maker Activity Patterns ──────────────────────────────────────────

/**
 * Analyze price series for market maker activity patterns.
 *
 * Detects:
 * - Accumulation: Price declining on decreasing volatility (MM buying)
 * - Distribution: Price rising on decreasing volatility (MM selling)
 * - Spread tightening: Volatility dropping significantly (MM providing liquidity)
 * - Spread widening: Volatility spiking (MM withdrawing liquidity)
 * - Mean reversion: Price reverting to a rolling mean after deviation
 * - Momentum ignition: Sharp price move followed by continuation
 */
export function detectMarketMakerPatterns(
  priceHistory: Record<string, PriceSnapshot[]>,
  marketId: string,
  outcome: string = 'Yes',
  windowMs: number = 3600000, // 1 hour default
): MarketMakerSignal[] {
  const series = extractSeries(priceHistory, marketId, outcome);
  const signals: MarketMakerSignal[] = [];

  if (series.prices.length < 5) return signals;

  const prices = series.prices;
  const n = prices.length;

  // Split into recent and older halves for comparison
  const midpoint = Math.floor(n / 2);
  const olderHalf = prices.slice(0, midpoint);
  const recentHalf = prices.slice(midpoint);

  // Compute volatility for each half
  const computeVolatility = (arr: number[]): number => {
    if (arr.length < 2) return 0;
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const variance = arr.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / arr.length;
    return Math.sqrt(variance);
  };

  const olderVol = computeVolatility(olderHalf);
  const recentVol = computeVolatility(recentHalf);

  // Compute trend direction
  const olderMean = olderHalf.reduce((a, b) => a + b, 0) / olderHalf.length;
  const recentMean = recentHalf.reduce((a, b) => a + b, 0) / recentHalf.length;
  const priceChange = recentMean - olderMean;

  // ─── Accumulation ─────────────────────────────────────────────
  if (priceChange < -2 && recentVol < olderVol * 0.7 && olderVol > 0) {
    const strength = Math.min(1, Math.abs(priceChange) / 10 * (1 - recentVol / olderVol));
    signals.push({
      marketId,
      pattern: 'accumulation',
      strength: parseFloat(strength.toFixed(3)),
      evidence: `Price declined ${Math.abs(priceChange).toFixed(1)}pp with ${((1 - recentVol / olderVol) * 100).toFixed(0)}% volatility reduction`,
      windowMs,
      actionable: strength > 0.3,
    });
  }

  // ─── Distribution ─────────────────────────────────────────────
  if (priceChange > 2 && recentVol < olderVol * 0.7 && olderVol > 0) {
    const strength = Math.min(1, priceChange / 10 * (1 - recentVol / olderVol));
    signals.push({
      marketId,
      pattern: 'distribution',
      strength: parseFloat(strength.toFixed(3)),
      evidence: `Price rose ${priceChange.toFixed(1)}pp with ${((1 - recentVol / olderVol) * 100).toFixed(0)}% volatility reduction`,
      windowMs,
      actionable: strength > 0.3,
    });
  }

  // ─── Spread Tightening ────────────────────────────────────────
  if (olderVol > 0 && recentVol < olderVol * 0.5) {
    const strength = Math.min(1, 1 - recentVol / olderVol);
    signals.push({
      marketId,
      pattern: 'spread_tightening',
      strength: parseFloat(strength.toFixed(3)),
      evidence: `Volatility dropped from ${olderVol.toFixed(2)} to ${recentVol.toFixed(2)} (${((1 - recentVol / olderVol) * 100).toFixed(0)}% reduction)`,
      windowMs,
      actionable: strength > 0.5,
    });
  }

  // ─── Spread Widening ──────────────────────────────────────────
  // Case 1: Both non-zero and recent is > 2x older
  // Case 2: Older was zero (flat) and recent has significant volatility
  if (olderVol > 0 && recentVol > olderVol * 2.0) {
    const strength = Math.min(1, (recentVol / olderVol - 1) / 3);
    signals.push({
      marketId,
      pattern: 'spread_widening',
      strength: parseFloat(strength.toFixed(3)),
      evidence: `Volatility surged from ${olderVol.toFixed(2)} to ${recentVol.toFixed(2)} (${((recentVol / olderVol - 1) * 100).toFixed(0)}% increase)`,
      windowMs,
      actionable: strength > 0.3,
    });
  } else if (olderVol === 0 && recentVol > 5) {
    // From completely flat to volatile — extreme spread widening
    const strength = Math.min(1, recentVol / 30);
    signals.push({
      marketId,
      pattern: 'spread_widening',
      strength: parseFloat(strength.toFixed(3)),
      evidence: `Volatility surged from 0 (flat) to ${recentVol.toFixed(2)} — market became highly volatile`,
      windowMs,
      actionable: true,
    });
  }

  // ─── Mean Reversion ───────────────────────────────────────────
  // Check if the most recent prices are reverting toward the long-term mean
  const longMean = prices.reduce((a, b) => a + b, 0) / n;
  const lastPrice = prices[n - 1]!;
  const prevDeviation = prices[Math.max(0, n - 4)]! - longMean;
  const currentDeviation = lastPrice - longMean;

  if (Math.abs(prevDeviation) > 3 && Math.abs(currentDeviation) < Math.abs(prevDeviation) * 0.5) {
    const strength = Math.min(1, (1 - Math.abs(currentDeviation) / Math.abs(prevDeviation)));
    signals.push({
      marketId,
      pattern: 'mean_reversion',
      strength: parseFloat(strength.toFixed(3)),
      evidence: `Price reverting to mean (${longMean.toFixed(1)}): deviation was ${prevDeviation.toFixed(1)}, now ${currentDeviation.toFixed(1)}`,
      windowMs,
      actionable: strength > 0.4,
    });
  }

  // ─── Momentum Ignition ────────────────────────────────────────
  // Check for sharp initial move followed by continuation in same direction
  if (n >= 6) {
    const initialMove = prices[Math.floor(n * 0.3)]! - prices[0]!;
    const continuation = prices[n - 1]! - prices[Math.floor(n * 0.3)]!;

    if (Math.abs(initialMove) > 3 && Math.sign(initialMove) === Math.sign(continuation) && Math.abs(continuation) > 2) {
      const totalMove = Math.abs(initialMove) + Math.abs(continuation);
      const strength = Math.min(1, totalMove / 15);
      signals.push({
        marketId,
        pattern: 'momentum_ignition',
        strength: parseFloat(strength.toFixed(3)),
        evidence: `Sharp ${initialMove > 0 ? 'up' : 'down'}move of ${Math.abs(initialMove).toFixed(1)}pp followed by ${Math.abs(continuation).toFixed(1)}pp continuation`,
        windowMs,
        actionable: strength > 0.4,
      });
    }
  }

  return signals;
}

// ─── Market Regime Detection ─────────────────────────────────────────────────

/**
 * Classify the current market regime (bullish/bearish/ranging/volatile)
 * based on recent price history and statistical properties.
 */
export function detectMarketRegime(
  priceHistory: Record<string, PriceSnapshot[]>,
  marketId: string,
  outcome: string = 'Yes',
): MarketRegime {
  const series = extractSeries(priceHistory, marketId, outcome);

  if (series.prices.length < 3) {
    return {
      marketId,
      outcome,
      regime: 'ranging',
      confidence: 0,
      trendStrength: 0,
      avgReturn: 0,
      volatility: 0,
    };
  }

  const prices = series.prices;
  const n = prices.length;

  // Compute returns (price changes)
  const returns: number[] = [];
  for (let i = 1; i < n; i++) {
    returns.push(prices[i]! - prices[i - 1]!);
  }

  // Average return
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;

  // Volatility (standard deviation of returns)
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
  const volatility = Math.sqrt(variance);

  // Trend strength: how consistently the price moves in one direction
  const positiveReturns = returns.filter(r => r > 0).length;
  const negativeReturns = returns.filter(r => r < 0).length;
  const totalNonZero = positiveReturns + negativeReturns;
  const directionality = totalNonZero > 0 ? Math.abs(positiveReturns - negativeReturns) / totalNonZero : 0;

  // Linear regression slope for trend strength
  const xMean = (n - 1) / 2;
  const yMean = prices.reduce((a, b) => a + b, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i++) {
    numerator += (i - xMean) * (prices[i]! - yMean);
    denominator += (i - xMean) * (i - xMean);
  }
  const slope = denominator !== 0 ? numerator / denominator : 0;
  const trendStrength = parseFloat(Math.abs(slope).toFixed(4));

  // Classify regime
  let regime: MarketRegime['regime'];
  let confidence: number;

  if (volatility > 5 && directionality < 0.3) {
    regime = 'volatile';
    confidence = Math.min(1, volatility / 10);
  } else if (avgReturn > 0.5 && directionality > 0.3) {
    regime = 'bullish';
    confidence = Math.min(1, directionality * (1 + avgReturn / 5));
  } else if (avgReturn < -0.5 && directionality > 0.3) {
    regime = 'bearish';
    confidence = Math.min(1, directionality * (1 + Math.abs(avgReturn) / 5));
  } else {
    regime = 'ranging';
    confidence = Math.min(1, 1 - directionality);
  }

  return {
    marketId,
    outcome,
    regime,
    confidence: parseFloat(confidence.toFixed(3)),
    trendStrength,
    avgReturn: parseFloat(avgReturn.toFixed(4)),
    volatility: parseFloat(volatility.toFixed(4)),
  };
}

// ─── Enhanced Correlation Matrix ─────────────────────────────────────────────

/**
 * Build an enhanced correlation matrix with market clustering,
 * independence detection, and summary statistics.
 *
 * Uses single-linkage clustering: two markets are in the same cluster
 * if their absolute correlation exceeds clusterThreshold.
 */
export function buildEnhancedCorrelationMatrix(
  priceHistory: Record<string, PriceSnapshot[]>,
  marketIds: string[],
  outcome: string = 'Yes',
  clusterThreshold: number = 0.6,
): EnhancedCorrelationMatrix {
  const n = marketIds.length;
  const matrix: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
  const pairs: CorrelationPair[] = [];

  // Extract series
  const series: Record<string, number[]> = {};
  for (const id of marketIds) {
    const s = extractSeries(priceHistory, id, outcome);
    series[id] = s.prices;
  }

  // Build matrix
  for (let i = 0; i < n; i++) {
    matrix[i]![i] = 1.0;
    for (let j = i + 1; j < n; j++) {
      const xSeries = series[marketIds[i]!] || [];
      const ySeries = series[marketIds[j]!] || [];
      const r = pearsonCorrelation(xSeries, ySeries);
      matrix[i]![j] = r;
      matrix[j]![i] = r;

      pairs.push({
        marketA: marketIds[i]!,
        marketB: marketIds[j]!,
        correlation: r,
        dataPoints: Math.min(xSeries.length, ySeries.length),
        significance: classifyCorrelation(r),
      });
    }
  }

  pairs.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));

  // Average correlation
  let totalCorr = 0;
  let pairCount = 0;
  for (const p of pairs) {
    totalCorr += p.correlation;
    pairCount++;
  }
  const averageCorrelation = pairCount > 0 ? parseFloat((totalCorr / pairCount).toFixed(4)) : 0;

  // Clustering via Union-Find
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    if (parent[x] !== x) parent[x] = find(parent[x]!);
    return parent[x]!;
  };
  const union = (a: number, b: number) => {
    parent[find(a)] = find(b);
  };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(matrix[i]![j]!) >= clusterThreshold) {
        union(i, j);
      }
    }
  }

  // Build clusters
  const clusterMap = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!clusterMap.has(root)) clusterMap.set(root, []);
    clusterMap.get(root)!.push(i);
  }

  const clusters: EnhancedCorrelationMatrix['clusters'] = [];
  for (const [, members] of clusterMap) {
    if (members.length < 2) continue;

    let totalPairCorr = 0;
    let pairCnt = 0;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        totalPairCorr += Math.abs(matrix[members[i]!]![members[j]!]!);
        pairCnt++;
      }
    }

    clusters.push({
      markets: members.map(i => marketIds[i]!),
      avgCorrelation: pairCnt > 0 ? parseFloat((totalPairCorr / pairCnt).toFixed(4)) : 0,
      label: `Cluster of ${members.length} correlated markets`,
    });
  }

  // Independent markets: |r| < 0.2 with all others
  const independentMarkets: string[] = [];
  for (let i = 0; i < n; i++) {
    let isIndependent = true;
    for (let j = 0; j < n; j++) {
      if (i !== j && Math.abs(matrix[i]![j]!) >= 0.2) {
        isIndependent = false;
        break;
      }
    }
    if (isIndependent) independentMarkets.push(marketIds[i]!);
  }

  return {
    markets: marketIds,
    outcome,
    matrix,
    pairs,
    clusters,
    averageCorrelation,
    independentMarkets,
    analyzedAt: Date.now(),
  };
}

// ─── Utility: Compute Returns ────────────────────────────────────────────────

/**
 * Compute period-over-period returns from a price series.
 * Returns are in percentage-point terms (not percent-of-percent).
 */
export function computeReturns(prices: number[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push(prices[i]! - prices[i - 1]!);
  }
  return returns;
}

/**
 * Compute Spearman rank correlation between two series.
 * More robust than Pearson for non-linear monotonic relationships.
 */
export function spearmanCorrelation(xValues: number[], yValues: number[]): number {
  const n = Math.min(xValues.length, yValues.length);
  if (n < 3) return 0;

  const x = xValues.slice(-n);
  const y = yValues.slice(-n);

  // Rank each series
  const rank = (arr: number[]): number[] => {
    const sorted = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const ranks = new Array(arr.length);
    for (let i = 0; i < sorted.length; i++) {
      ranks[sorted[i]!.i] = i + 1;
    }
    return ranks;
  };

  const rankX = rank(x);
  const rankY = rank(y);

  return pearsonCorrelation(rankX, rankY);
}

// ─── Default Export ──────────────────────────────────────────────────────────

export default {
  extractSeries,
  alignSeries,
  computeRollingCorrelation,
  estimateConditionalProbability,
  conditionalProbabilityMatrix,
  detectMutuallyExclusiveArbitrage,
  detectSubsetArbitrage,
  scanCrossMarketArbitrage,
  detectMarketMakerPatterns,
  detectMarketRegime,
  buildEnhancedCorrelationMatrix,
  computeReturns,
  spearmanCorrelation,
};
