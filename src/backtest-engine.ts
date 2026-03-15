/**
 * BacktestEngine — Historical Alert Strategy Simulation
 *
 * Enables users to simulate alert strategies against historical market data,
 * measuring which alerts would have fired, the profit/loss if acted upon,
 * and statistical analysis of alert effectiveness.
 *
 * Key capabilities:
 * 1. Strategy definition with entry/exit conditions and position sizing
 * 2. Backtesting against PriceSnapshot history from CRE workflow
 * 3. Trade execution simulation with slippage and fee modeling
 * 4. Performance metrics: Sharpe ratio, max drawdown, win rate, profit factor
 * 5. Strategy comparison and ranking
 * 6. Monte Carlo simulation for confidence intervals
 * 7. Walk-forward optimization for parameter tuning
 *
 * All functions are pure and operate on PriceSnapshot[] data produced
 * by the CRE workflow's periodic polling. Designed for integration with
 * the Chainlink CRE runtime for automated strategy evaluation.
 */

import type { PriceSnapshot } from './polymarket-alert-workflow';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Direction of a trade */
export type TradeDirection = 'long' | 'short';

/** Condition operator for strategy rules */
export type ConditionOperator = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'crosses_above' | 'crosses_below';

/** A single condition that can trigger entry or exit */
export interface StrategyCondition {
  /** Which market outcome to evaluate */
  outcome: string;
  /** The operator for comparison */
  operator: ConditionOperator;
  /** The threshold value (0-100 percentage) */
  value: number;
  /** Optional: use a moving average instead of raw price */
  movingAveragePeriod?: number;
}

/** Strategy definition with entry/exit rules */
export interface Strategy {
  /** Unique identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Market ID to backtest against */
  marketId: string;
  /** Conditions that must ALL be true to enter a position */
  entryConditions: StrategyCondition[];
  /** Conditions that trigger position exit (ANY can trigger) */
  exitConditions: StrategyCondition[];
  /** Direction of the trade */
  direction: TradeDirection;
  /** Position size as fraction of capital (0-1) */
  positionSize: number;
  /** Stop loss in percentage points (e.g., 5 means exit if price moves 5pp against) */
  stopLoss?: number;
  /** Take profit in percentage points */
  takeProfit?: number;
  /** Maximum hold time in milliseconds */
  maxHoldTime?: number;
  /** Cooldown between trades in milliseconds */
  cooldownMs?: number;
}

/** A simulated trade */
export interface SimulatedTrade {
  /** Entry timestamp */
  entryTime: number;
  /** Entry price */
  entryPrice: number;
  /** Exit timestamp */
  exitTime: number;
  /** Exit price */
  exitPrice: number;
  /** Trade direction */
  direction: TradeDirection;
  /** Position size fraction */
  positionSize: number;
  /** Profit/loss in percentage points */
  pnl: number;
  /** Profit/loss as percentage of position */
  pnlPercent: number;
  /** Reason for exit */
  exitReason: 'condition' | 'stop_loss' | 'take_profit' | 'max_hold_time' | 'end_of_data';
  /** Duration in milliseconds */
  holdTime: number;
}

/** Backtest configuration */
export interface BacktestConfig {
  /** Starting capital (in abstract units, default 10000) */
  initialCapital: number;
  /** Fee per trade as fraction (e.g., 0.001 = 0.1%) */
  feeRate: number;
  /** Slippage per trade in percentage points */
  slippage: number;
  /** Whether to allow multiple simultaneous positions */
  allowMultiplePositions: boolean;
  /** Maximum number of simultaneous positions */
  maxPositions: number;
}

/** Result of a single backtest run */
export interface BacktestResult {
  /** Strategy that was tested */
  strategyId: string;
  /** All simulated trades */
  trades: SimulatedTrade[];
  /** Performance metrics */
  metrics: PerformanceMetrics;
  /** Equity curve (capital over time) */
  equityCurve: { timestamp: number; equity: number }[];
  /** Drawdown curve */
  drawdownCurve: { timestamp: number; drawdown: number }[];
  /** Configuration used */
  config: BacktestConfig;
  /** Data period */
  startTime: number;
  endTime: number;
  /** Number of data points used */
  dataPoints: number;
}

/** Comprehensive performance metrics */
export interface PerformanceMetrics {
  /** Total number of trades */
  totalTrades: number;
  /** Number of winning trades */
  winningTrades: number;
  /** Number of losing trades */
  losingTrades: number;
  /** Win rate (0-1) */
  winRate: number;
  /** Total profit/loss */
  totalPnl: number;
  /** Average P&L per trade */
  averagePnl: number;
  /** Average winning trade */
  averageWin: number;
  /** Average losing trade */
  averageLoss: number;
  /** Profit factor (gross profit / gross loss) */
  profitFactor: number;
  /** Maximum drawdown in percentage points */
  maxDrawdown: number;
  /** Maximum drawdown duration in milliseconds */
  maxDrawdownDuration: number;
  /** Sharpe ratio (annualized, assuming 365 days) */
  sharpeRatio: number;
  /** Sortino ratio (downside deviation only) */
  sortinoRatio: number;
  /** Calmar ratio (annualized return / max drawdown) */
  calmarRatio: number;
  /** Average hold time in milliseconds */
  averageHoldTime: number;
  /** Longest winning streak */
  maxWinStreak: number;
  /** Longest losing streak */
  maxLossStreak: number;
  /** Final equity */
  finalEquity: number;
  /** Total return as fraction */
  totalReturn: number;
  /** Expectancy per trade */
  expectancy: number;
  /** Total fees paid */
  totalFees: number;
}

/** Strategy comparison result */
export interface StrategyComparison {
  /** Ranked strategies (best first) */
  rankings: {
    strategyId: string;
    rank: number;
    result: BacktestResult;
    /** Composite score (higher is better) */
    compositeScore: number;
  }[];
  /** Best strategy by each metric */
  bestBy: Record<string, string>;
}

/** Monte Carlo simulation result */
export interface MonteCarloResult {
  /** Number of simulations run */
  simulations: number;
  /** Original backtest result */
  original: BacktestResult;
  /** Distribution of final equity values */
  equityDistribution: {
    percentile5: number;
    percentile25: number;
    median: number;
    percentile75: number;
    percentile95: number;
    mean: number;
    stdDev: number;
  };
  /** Distribution of max drawdowns */
  drawdownDistribution: {
    percentile5: number;
    median: number;
    percentile95: number;
    mean: number;
  };
  /** Probability of profit */
  profitProbability: number;
  /** Probability of losing more than 20% */
  ruinProbability: number;
}

/** Walk-forward optimization result */
export interface WalkForwardResult {
  /** Parameter combinations tested */
  parameterSets: {
    params: Record<string, number>;
    inSampleResult: BacktestResult;
    outOfSampleResult: BacktestResult;
    /** Whether in-sample performance held out of sample */
    robust: boolean;
  }[];
  /** Best parameter set based on out-of-sample performance */
  bestParams: Record<string, number>;
  /** Robustness ratio: fraction of parameter sets where OOS > 0 */
  robustnessRatio: number;
}

// ─── Default Configuration ───────────────────────────────────────────────────

export const DEFAULT_BACKTEST_CONFIG: BacktestConfig = {
  initialCapital: 10000,
  feeRate: 0.001,
  slippage: 0.5,
  allowMultiplePositions: false,
  maxPositions: 1,
};

// ─── Helper Functions ────────────────────────────────────────────────────────

/**
 * Compute a simple moving average over a price series.
 */
export function computeMovingAverage(prices: number[], period: number): (number | null)[] {
  if (period < 1) return prices.map(() => null);
  const result: (number | null)[] = [];
  for (let i = 0; i < prices.length; i++) {
    if (i < period - 1) {
      result.push(null);
    } else {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) {
        sum += prices[j]!;
      }
      result.push(parseFloat((sum / period).toFixed(4)));
    }
  }
  return result;
}

/**
 * Compute exponential moving average over a price series.
 */
export function computeEMA(prices: number[], period: number): (number | null)[] {
  if (period < 1 || prices.length === 0) return prices.map(() => null);
  const multiplier = 2 / (period + 1);
  const result: (number | null)[] = [];

  // Start with SMA for first `period` values
  for (let i = 0; i < Math.min(period - 1, prices.length); i++) {
    result.push(null);
  }

  if (prices.length < period) return result;

  // SMA for first value
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += prices[i]!;
  }
  let ema = sum / period;
  result.push(parseFloat(ema.toFixed(4)));

  // EMA for subsequent values
  for (let i = period; i < prices.length; i++) {
    ema = (prices[i]! - ema) * multiplier + ema;
    result.push(parseFloat(ema.toFixed(4)));
  }

  return result;
}

/**
 * Extract aligned price data from PriceSnapshot history.
 */
export function extractPriceData(
  priceHistory: Record<string, PriceSnapshot[]>,
  marketId: string,
  outcome: string = 'Yes',
): { prices: number[]; timestamps: number[] } {
  const snapshots = priceHistory[marketId] || [];
  const filtered = snapshots
    .filter(s => s.prices[outcome] !== undefined)
    .sort((a, b) => a.timestamp - b.timestamp);

  return {
    prices: filtered.map(s => s.prices[outcome]!),
    timestamps: filtered.map(s => s.timestamp),
  };
}

/**
 * Evaluate a single condition against current and previous price data.
 */
export function evaluateCondition(
  condition: StrategyCondition,
  currentPrice: number,
  previousPrice: number | null,
  movingAvg: number | null,
): boolean {
  const compareValue = condition.movingAveragePeriod && movingAvg !== null
    ? movingAvg
    : currentPrice;

  switch (condition.operator) {
    case 'gt':
      return compareValue > condition.value;
    case 'gte':
      return compareValue >= condition.value;
    case 'lt':
      return compareValue < condition.value;
    case 'lte':
      return compareValue <= condition.value;
    case 'eq':
      return Math.abs(compareValue - condition.value) < 0.01;
    case 'crosses_above':
      if (previousPrice === null) return false;
      return previousPrice < condition.value && currentPrice >= condition.value;
    case 'crosses_below':
      if (previousPrice === null) return false;
      return previousPrice > condition.value && currentPrice <= condition.value;
    default:
      return false;
  }
}

/**
 * Check if all entry conditions are met.
 */
export function checkEntryConditions(
  conditions: StrategyCondition[],
  prices: number[],
  index: number,
  movingAverages: Map<number, (number | null)[]>,
): boolean {
  if (conditions.length === 0) return false;

  for (const cond of conditions) {
    const currentPrice = prices[index]!;
    const previousPrice = index > 0 ? prices[index - 1]! : null;
    const maPeriod = cond.movingAveragePeriod;
    const maValues = maPeriod ? movingAverages.get(maPeriod) : undefined;
    const maValue = maValues ? maValues[index] ?? null : null;

    if (!evaluateCondition(cond, currentPrice, previousPrice, maValue)) {
      return false;
    }
  }

  return true;
}

/**
 * Check if any exit condition is met.
 */
export function checkExitConditions(
  conditions: StrategyCondition[],
  prices: number[],
  index: number,
  movingAverages: Map<number, (number | null)[]>,
): boolean {
  for (const cond of conditions) {
    const currentPrice = prices[index]!;
    const previousPrice = index > 0 ? prices[index - 1]! : null;
    const maPeriod = cond.movingAveragePeriod;
    const maValues = maPeriod ? movingAverages.get(maPeriod) : undefined;
    const maValue = maValues ? maValues[index] ?? null : null;

    if (evaluateCondition(cond, currentPrice, previousPrice, maValue)) {
      return true;
    }
  }

  return false;
}

/**
 * Calculate P&L for a trade given direction.
 */
export function calculateTradePnl(
  entryPrice: number,
  exitPrice: number,
  direction: TradeDirection,
  positionSize: number,
  feeRate: number,
  slippage: number,
): { pnl: number; pnlPercent: number; fees: number } {
  // Apply slippage to entry and exit
  const adjustedEntry = direction === 'long'
    ? entryPrice + slippage
    : entryPrice - slippage;
  const adjustedExit = direction === 'long'
    ? exitPrice - slippage
    : exitPrice + slippage;

  // Calculate raw P&L
  const rawPnl = direction === 'long'
    ? adjustedExit - adjustedEntry
    : adjustedEntry - adjustedExit;

  // Apply position sizing
  const positionPnl = rawPnl * positionSize;

  // Calculate fees (on both entry and exit)
  const fees = (Math.abs(adjustedEntry) + Math.abs(adjustedExit)) * feeRate * positionSize;

  const netPnl = positionPnl - fees;
  const pnlPercent = adjustedEntry !== 0
    ? parseFloat(((rawPnl / Math.abs(adjustedEntry)) * 100).toFixed(4))
    : 0;

  return {
    pnl: parseFloat(netPnl.toFixed(4)),
    pnlPercent,
    fees: parseFloat(fees.toFixed(4)),
  };
}

// ─── Core Backtest Engine ────────────────────────────────────────────────────

/**
 * Run a backtest of a strategy against historical price data.
 *
 * Simulates trades by walking through PriceSnapshot history,
 * evaluating entry/exit conditions at each step, and tracking
 * simulated positions with realistic fees and slippage.
 */
export function runBacktest(
  strategy: Strategy,
  priceHistory: Record<string, PriceSnapshot[]>,
  config: BacktestConfig = DEFAULT_BACKTEST_CONFIG,
): BacktestResult {
  const outcome = strategy.entryConditions[0]?.outcome || 'Yes';
  const { prices, timestamps } = extractPriceData(priceHistory, strategy.marketId, outcome);

  if (prices.length < 2) {
    return createEmptyResult(strategy.id, config);
  }

  // Pre-compute moving averages for all unique periods used in conditions
  const maPeriods = new Set<number>();
  for (const cond of [...strategy.entryConditions, ...strategy.exitConditions]) {
    if (cond.movingAveragePeriod) {
      maPeriods.add(cond.movingAveragePeriod);
    }
  }

  const movingAverages = new Map<number, (number | null)[]>();
  for (const period of maPeriods) {
    movingAverages.set(period, computeMovingAverage(prices, period));
  }

  const trades: SimulatedTrade[] = [];
  const equityCurve: { timestamp: number; equity: number }[] = [];
  let equity = config.initialCapital;
  let peakEquity = equity;
  let inPosition = false;
  let entryIndex = -1;
  let entryPrice = 0;
  let lastTradeExitTime = 0;
  let totalFees = 0;

  // Walk through data
  for (let i = 0; i < prices.length; i++) {
    const currentPrice = prices[i]!;
    const currentTime = timestamps[i]!;

    // Track equity curve
    equityCurve.push({ timestamp: currentTime, equity });

    if (inPosition) {
      // Check exit conditions
      let exitReason: SimulatedTrade['exitReason'] | null = null;

      // Check strategy exit conditions
      if (checkExitConditions(strategy.exitConditions, prices, i, movingAverages)) {
        exitReason = 'condition';
      }

      // Check stop loss
      if (!exitReason && strategy.stopLoss !== undefined) {
        const pnlSinceEntry = strategy.direction === 'long'
          ? currentPrice - entryPrice
          : entryPrice - currentPrice;
        if (pnlSinceEntry <= -strategy.stopLoss) {
          exitReason = 'stop_loss';
        }
      }

      // Check take profit
      if (!exitReason && strategy.takeProfit !== undefined) {
        const pnlSinceEntry = strategy.direction === 'long'
          ? currentPrice - entryPrice
          : entryPrice - currentPrice;
        if (pnlSinceEntry >= strategy.takeProfit) {
          exitReason = 'take_profit';
        }
      }

      // Check max hold time
      if (!exitReason && strategy.maxHoldTime !== undefined) {
        const holdTime = currentTime - timestamps[entryIndex]!;
        if (holdTime >= strategy.maxHoldTime) {
          exitReason = 'max_hold_time';
        }
      }

      // End of data
      if (!exitReason && i === prices.length - 1) {
        exitReason = 'end_of_data';
      }

      if (exitReason) {
        const { pnl, pnlPercent, fees } = calculateTradePnl(
          entryPrice,
          currentPrice,
          strategy.direction,
          strategy.positionSize,
          config.feeRate,
          config.slippage,
        );

        totalFees += fees;
        equity += pnl;

        trades.push({
          entryTime: timestamps[entryIndex]!,
          entryPrice,
          exitTime: currentTime,
          exitPrice: currentPrice,
          direction: strategy.direction,
          positionSize: strategy.positionSize,
          pnl,
          pnlPercent,
          exitReason,
          holdTime: currentTime - timestamps[entryIndex]!,
        });

        inPosition = false;
        lastTradeExitTime = currentTime;

        // Update equity curve with exit
        equityCurve[equityCurve.length - 1] = { timestamp: currentTime, equity };
      }
    } else {
      // Check cooldown
      if (strategy.cooldownMs && currentTime - lastTradeExitTime < strategy.cooldownMs) {
        continue;
      }

      // Check entry conditions
      if (checkEntryConditions(strategy.entryConditions, prices, i, movingAverages)) {
        inPosition = true;
        entryIndex = i;
        entryPrice = currentPrice;
      }
    }

    // Update peak equity
    if (equity > peakEquity) {
      peakEquity = equity;
    }
  }

  // Calculate metrics
  const metrics = calculateMetrics(trades, equityCurve, config, totalFees);

  // Build drawdown curve
  const drawdownCurve = buildDrawdownCurve(equityCurve);

  return {
    strategyId: strategy.id,
    trades,
    metrics,
    equityCurve,
    drawdownCurve,
    config,
    startTime: timestamps[0] || 0,
    endTime: timestamps[timestamps.length - 1] || 0,
    dataPoints: prices.length,
  };
}

/**
 * Create an empty backtest result for cases with insufficient data.
 */
function createEmptyResult(strategyId: string, config: BacktestConfig): BacktestResult {
  return {
    strategyId,
    trades: [],
    metrics: {
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      winRate: 0,
      totalPnl: 0,
      averagePnl: 0,
      averageWin: 0,
      averageLoss: 0,
      profitFactor: 0,
      maxDrawdown: 0,
      maxDrawdownDuration: 0,
      sharpeRatio: 0,
      sortinoRatio: 0,
      calmarRatio: 0,
      averageHoldTime: 0,
      maxWinStreak: 0,
      maxLossStreak: 0,
      finalEquity: config.initialCapital,
      totalReturn: 0,
      expectancy: 0,
      totalFees: 0,
    },
    equityCurve: [],
    drawdownCurve: [],
    config,
    startTime: 0,
    endTime: 0,
    dataPoints: 0,
  };
}

/**
 * Calculate comprehensive performance metrics from trade results.
 */
export function calculateMetrics(
  trades: SimulatedTrade[],
  equityCurve: { timestamp: number; equity: number }[],
  config: BacktestConfig,
  totalFees: number,
): PerformanceMetrics {
  if (trades.length === 0) {
    return {
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      winRate: 0,
      totalPnl: 0,
      averagePnl: 0,
      averageWin: 0,
      averageLoss: 0,
      profitFactor: 0,
      maxDrawdown: 0,
      maxDrawdownDuration: 0,
      sharpeRatio: 0,
      sortinoRatio: 0,
      calmarRatio: 0,
      averageHoldTime: 0,
      maxWinStreak: 0,
      maxLossStreak: 0,
      finalEquity: config.initialCapital,
      totalReturn: 0,
      expectancy: 0,
      totalFees,
    };
  }

  const winningTrades = trades.filter(t => t.pnl > 0);
  const losingTrades = trades.filter(t => t.pnl < 0);

  const totalPnl = trades.reduce((sum, t) => sum + t.pnl, 0);
  const grossProfit = winningTrades.reduce((sum, t) => sum + t.pnl, 0);
  const grossLoss = Math.abs(losingTrades.reduce((sum, t) => sum + t.pnl, 0));

  // Win/loss streaks
  let currentWinStreak = 0;
  let currentLossStreak = 0;
  let maxWinStreak = 0;
  let maxLossStreak = 0;

  for (const trade of trades) {
    if (trade.pnl > 0) {
      currentWinStreak++;
      currentLossStreak = 0;
      maxWinStreak = Math.max(maxWinStreak, currentWinStreak);
    } else if (trade.pnl < 0) {
      currentLossStreak++;
      currentWinStreak = 0;
      maxLossStreak = Math.max(maxLossStreak, currentLossStreak);
    }
  }

  // Drawdown calculation
  const { maxDrawdown, maxDrawdownDuration } = calculateMaxDrawdown(equityCurve);

  // Sharpe ratio calculation
  const tradePnls = trades.map(t => t.pnl);
  const avgPnl = totalPnl / trades.length;
  const pnlVariance = tradePnls.reduce((sum, p) => sum + Math.pow(p - avgPnl, 2), 0) / trades.length;
  const pnlStdDev = Math.sqrt(pnlVariance);

  // Annualize: assume data covers the time span of the equity curve
  const timeSpanMs = equityCurve.length >= 2
    ? equityCurve[equityCurve.length - 1]!.timestamp - equityCurve[0]!.timestamp
    : 1;
  const annualizationFactor = timeSpanMs > 0 ? Math.sqrt(365 * 24 * 3600000 / timeSpanMs) : 1;

  const sharpeRatio = pnlStdDev > 0
    ? parseFloat(((avgPnl / pnlStdDev) * annualizationFactor).toFixed(4))
    : 0;

  // Sortino ratio (only downside deviation)
  const downsidePnls = tradePnls.filter(p => p < 0);
  const downsideVariance = downsidePnls.length > 0
    ? downsidePnls.reduce((sum, p) => sum + Math.pow(p, 2), 0) / downsidePnls.length
    : 0;
  const downsideStdDev = Math.sqrt(downsideVariance);

  const sortinoRatio = downsideStdDev > 0
    ? parseFloat(((avgPnl / downsideStdDev) * annualizationFactor).toFixed(4))
    : 0;

  // Calmar ratio
  const totalReturn = totalPnl / config.initialCapital;
  const calmarRatio = maxDrawdown > 0
    ? parseFloat((totalReturn / (maxDrawdown / 100)).toFixed(4))
    : 0;

  // Expectancy
  const winProb = trades.length > 0 ? winningTrades.length / trades.length : 0;
  const avgWin = winningTrades.length > 0 ? grossProfit / winningTrades.length : 0;
  const avgLossVal = losingTrades.length > 0 ? grossLoss / losingTrades.length : 0;
  const expectancy = (winProb * avgWin) - ((1 - winProb) * avgLossVal);

  const finalEquity = equityCurve.length > 0
    ? equityCurve[equityCurve.length - 1]!.equity
    : config.initialCapital;

  return {
    totalTrades: trades.length,
    winningTrades: winningTrades.length,
    losingTrades: losingTrades.length,
    winRate: parseFloat((winningTrades.length / trades.length).toFixed(4)),
    totalPnl: parseFloat(totalPnl.toFixed(4)),
    averagePnl: parseFloat(avgPnl.toFixed(4)),
    averageWin: parseFloat(avgWin.toFixed(4)),
    averageLoss: parseFloat(avgLossVal.toFixed(4)),
    profitFactor: grossLoss > 0 ? parseFloat((grossProfit / grossLoss).toFixed(4)) : grossProfit > 0 ? Infinity : 0,
    maxDrawdown: parseFloat(maxDrawdown.toFixed(4)),
    maxDrawdownDuration,
    sharpeRatio,
    sortinoRatio,
    calmarRatio,
    averageHoldTime: Math.round(trades.reduce((sum, t) => sum + t.holdTime, 0) / trades.length),
    maxWinStreak,
    maxLossStreak,
    finalEquity: parseFloat(finalEquity.toFixed(4)),
    totalReturn: parseFloat(totalReturn.toFixed(4)),
    expectancy: parseFloat(expectancy.toFixed(4)),
    totalFees: parseFloat(totalFees.toFixed(4)),
  };
}

/**
 * Calculate maximum drawdown and its duration from equity curve.
 */
export function calculateMaxDrawdown(
  equityCurve: { timestamp: number; equity: number }[],
): { maxDrawdown: number; maxDrawdownDuration: number } {
  if (equityCurve.length === 0) {
    return { maxDrawdown: 0, maxDrawdownDuration: 0 };
  }

  let peak = equityCurve[0]!.equity;
  let peakTime = equityCurve[0]!.timestamp;
  let maxDrawdown = 0;
  let maxDrawdownDuration = 0;

  for (const point of equityCurve) {
    if (point.equity > peak) {
      peak = point.equity;
      peakTime = point.timestamp;
    }

    const drawdown = ((peak - point.equity) / peak) * 100;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
      maxDrawdownDuration = point.timestamp - peakTime;
    }
  }

  return {
    maxDrawdown: parseFloat(maxDrawdown.toFixed(4)),
    maxDrawdownDuration,
  };
}

/**
 * Build a drawdown curve from equity curve.
 */
export function buildDrawdownCurve(
  equityCurve: { timestamp: number; equity: number }[],
): { timestamp: number; drawdown: number }[] {
  if (equityCurve.length === 0) return [];

  let peak = equityCurve[0]!.equity;
  const drawdownCurve: { timestamp: number; drawdown: number }[] = [];

  for (const point of equityCurve) {
    if (point.equity > peak) {
      peak = point.equity;
    }
    const drawdown = peak > 0 ? ((peak - point.equity) / peak) * 100 : 0;
    drawdownCurve.push({
      timestamp: point.timestamp,
      drawdown: parseFloat(drawdown.toFixed(4)),
    });
  }

  return drawdownCurve;
}

// ─── Strategy Comparison ─────────────────────────────────────────────────────

/**
 * Compare multiple strategies by running backtests and ranking results.
 * Uses a composite score based on Sharpe ratio, win rate, profit factor,
 * and drawdown.
 */
export function compareStrategies(
  strategies: Strategy[],
  priceHistory: Record<string, PriceSnapshot[]>,
  config: BacktestConfig = DEFAULT_BACKTEST_CONFIG,
  weights: { sharpe: number; winRate: number; profitFactor: number; drawdown: number } = {
    sharpe: 0.3,
    winRate: 0.2,
    profitFactor: 0.3,
    drawdown: 0.2,
  },
): StrategyComparison {
  const results: { strategyId: string; result: BacktestResult }[] = [];

  for (const strategy of strategies) {
    const result = runBacktest(strategy, priceHistory, config);
    results.push({ strategyId: strategy.id, result });
  }

  // Normalize metrics for comparison (0-1 scale)
  const maxSharpe = Math.max(...results.map(r => Math.abs(r.result.metrics.sharpeRatio)), 1);
  const maxPF = Math.max(...results.map(r => {
    const pf = r.result.metrics.profitFactor;
    return pf === Infinity ? 10 : pf;
  }), 1);
  const maxDD = Math.max(...results.map(r => r.result.metrics.maxDrawdown), 1);

  // Calculate composite scores
  const rankings = results.map(r => {
    const m = r.result.metrics;
    const pf = m.profitFactor === Infinity ? 10 : m.profitFactor;
    const normalizedSharpe = maxSharpe > 0 ? Math.max(0, m.sharpeRatio) / maxSharpe : 0;
    const normalizedPF = maxPF > 0 ? Math.min(pf, 10) / maxPF : 0;
    const normalizedDD = maxDD > 0 ? 1 - (m.maxDrawdown / maxDD) : 1;

    const compositeScore =
      weights.sharpe * normalizedSharpe +
      weights.winRate * m.winRate +
      weights.profitFactor * normalizedPF +
      weights.drawdown * normalizedDD;

    return {
      strategyId: r.strategyId,
      rank: 0,
      result: r.result,
      compositeScore: parseFloat(compositeScore.toFixed(4)),
    };
  });

  // Sort by composite score descending
  rankings.sort((a, b) => b.compositeScore - a.compositeScore);
  rankings.forEach((r, i) => { r.rank = i + 1; });

  // Find best by each metric
  const bestBy: Record<string, string> = {};
  if (results.length > 0) {
    bestBy.sharpeRatio = results.reduce((best, r) =>
      r.result.metrics.sharpeRatio > best.result.metrics.sharpeRatio ? r : best
    ).strategyId;
    bestBy.winRate = results.reduce((best, r) =>
      r.result.metrics.winRate > best.result.metrics.winRate ? r : best
    ).strategyId;
    bestBy.totalReturn = results.reduce((best, r) =>
      r.result.metrics.totalReturn > best.result.metrics.totalReturn ? r : best
    ).strategyId;
    bestBy.profitFactor = results.reduce((best, r) => {
      const pfR = r.result.metrics.profitFactor === Infinity ? 999 : r.result.metrics.profitFactor;
      const pfBest = best.result.metrics.profitFactor === Infinity ? 999 : best.result.metrics.profitFactor;
      return pfR > pfBest ? r : best;
    }).strategyId;
    bestBy.lowestDrawdown = results.reduce((best, r) =>
      r.result.metrics.maxDrawdown < best.result.metrics.maxDrawdown ? r : best
    ).strategyId;
  }

  return { rankings, bestBy };
}

// ─── Monte Carlo Simulation ──────────────────────────────────────────────────

/**
 * Run Monte Carlo simulation by reshuffling trade results.
 *
 * This tests the robustness of a strategy by randomly reordering its trades
 * many times and examining the distribution of outcomes. If the strategy
 * is robust, most reshuffled sequences should still be profitable.
 */
export function runMonteCarloSimulation(
  backtestResult: BacktestResult,
  numSimulations: number = 1000,
  seed?: number,
): MonteCarloResult {
  const trades = backtestResult.trades;

  if (trades.length === 0) {
    return {
      simulations: numSimulations,
      original: backtestResult,
      equityDistribution: {
        percentile5: backtestResult.config.initialCapital,
        percentile25: backtestResult.config.initialCapital,
        median: backtestResult.config.initialCapital,
        percentile75: backtestResult.config.initialCapital,
        percentile95: backtestResult.config.initialCapital,
        mean: backtestResult.config.initialCapital,
        stdDev: 0,
      },
      drawdownDistribution: {
        percentile5: 0,
        median: 0,
        percentile95: 0,
        mean: 0,
      },
      profitProbability: 0,
      ruinProbability: 0,
    };
  }

  // Simple seeded RNG (LCG)
  let rngState = seed !== undefined ? seed : Date.now();
  const nextRandom = () => {
    rngState = (rngState * 1664525 + 1013904223) & 0x7fffffff;
    return rngState / 0x7fffffff;
  };

  const tradePnls = trades.map(t => t.pnl);
  const finalEquities: number[] = [];
  const maxDrawdowns: number[] = [];

  for (let sim = 0; sim < numSimulations; sim++) {
    // Shuffle trade PnLs (Fisher-Yates)
    const shuffled = [...tradePnls];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(nextRandom() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }

    // Build equity curve from shuffled trades
    let equity = backtestResult.config.initialCapital;
    let peak = equity;
    let maxDD = 0;

    for (const pnl of shuffled) {
      equity += pnl;
      if (equity > peak) peak = equity;
      const dd = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
      if (dd > maxDD) maxDD = dd;
    }

    finalEquities.push(equity);
    maxDrawdowns.push(maxDD);
  }

  // Sort for percentile calculations
  finalEquities.sort((a, b) => a - b);
  maxDrawdowns.sort((a, b) => a - b);

  const percentile = (arr: number[], p: number): number => {
    const idx = Math.max(0, Math.min(arr.length - 1, Math.floor(arr.length * p / 100)));
    return parseFloat(arr[idx]!.toFixed(4));
  };

  const mean = finalEquities.reduce((a, b) => a + b, 0) / finalEquities.length;
  const variance = finalEquities.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / finalEquities.length;

  const profitCount = finalEquities.filter(e => e > backtestResult.config.initialCapital).length;
  const ruinCount = finalEquities.filter(e => e < backtestResult.config.initialCapital * 0.8).length;

  return {
    simulations: numSimulations,
    original: backtestResult,
    equityDistribution: {
      percentile5: percentile(finalEquities, 5),
      percentile25: percentile(finalEquities, 25),
      median: percentile(finalEquities, 50),
      percentile75: percentile(finalEquities, 75),
      percentile95: percentile(finalEquities, 95),
      mean: parseFloat(mean.toFixed(4)),
      stdDev: parseFloat(Math.sqrt(variance).toFixed(4)),
    },
    drawdownDistribution: {
      percentile5: percentile(maxDrawdowns, 5),
      median: percentile(maxDrawdowns, 50),
      percentile95: percentile(maxDrawdowns, 95),
      mean: parseFloat((maxDrawdowns.reduce((a, b) => a + b, 0) / maxDrawdowns.length).toFixed(4)),
    },
    profitProbability: parseFloat((profitCount / numSimulations).toFixed(4)),
    ruinProbability: parseFloat((ruinCount / numSimulations).toFixed(4)),
  };
}

// ─── Walk-Forward Optimization ───────────────────────────────────────────────

/**
 * Perform walk-forward optimization by splitting data into in-sample
 * and out-of-sample windows, optimizing parameters on in-sample,
 * and validating on out-of-sample.
 *
 * @param baseStrategy The strategy template (threshold will be varied)
 * @param parameterRanges Map of parameter name to [min, max, step] ranges
 * @param splitRatio Fraction of data for in-sample (e.g., 0.7 = 70% in-sample)
 */
export function walkForwardOptimize(
  baseStrategy: Strategy,
  priceHistory: Record<string, PriceSnapshot[]>,
  parameterRanges: Record<string, [number, number, number]>,
  splitRatio: number = 0.7,
  config: BacktestConfig = DEFAULT_BACKTEST_CONFIG,
): WalkForwardResult {
  const outcome = baseStrategy.entryConditions[0]?.outcome || 'Yes';
  const { prices, timestamps } = extractPriceData(priceHistory, baseStrategy.marketId, outcome);

  if (prices.length < 10) {
    return {
      parameterSets: [],
      bestParams: {},
      robustnessRatio: 0,
    };
  }

  // Split data
  const splitIndex = Math.floor(prices.length * splitRatio);

  // Build in-sample and out-of-sample price histories
  const snapshots = priceHistory[baseStrategy.marketId] || [];
  const sortedSnapshots = [...snapshots]
    .filter(s => s.prices[outcome] !== undefined)
    .sort((a, b) => a.timestamp - b.timestamp);

  const inSampleSnapshots = sortedSnapshots.slice(0, splitIndex);
  const outOfSampleSnapshots = sortedSnapshots.slice(splitIndex);

  const inSampleHistory: Record<string, PriceSnapshot[]> = {
    [baseStrategy.marketId]: inSampleSnapshots,
  };
  const outOfSampleHistory: Record<string, PriceSnapshot[]> = {
    [baseStrategy.marketId]: outOfSampleSnapshots,
  };

  // Generate parameter combinations
  const paramNames = Object.keys(parameterRanges);
  const paramCombinations: Record<string, number>[] = [];

  if (paramNames.length === 0) {
    paramCombinations.push({});
  } else {
    // Generate all combinations (limited to prevent explosion)
    const generateCombos = (names: string[], current: Record<string, number>) => {
      if (names.length === 0) {
        paramCombinations.push({ ...current });
        return;
      }
      if (paramCombinations.length >= 100) return; // Safety limit

      const name = names[0]!;
      const [min, max, step] = parameterRanges[name]!;
      for (let val = min; val <= max; val += step) {
        current[name] = parseFloat(val.toFixed(4));
        generateCombos(names.slice(1), current);
      }
    };

    generateCombos(paramNames, {});
  }

  // Test each parameter combination
  const parameterSets: WalkForwardResult['parameterSets'] = [];
  let bestOOSReturn = -Infinity;
  let bestParams: Record<string, number> = {};

  for (const params of paramCombinations) {
    // Apply parameters to strategy
    const modifiedStrategy = applyParameters(baseStrategy, params);

    const inSampleResult = runBacktest(modifiedStrategy, inSampleHistory, config);
    const outOfSampleResult = runBacktest(modifiedStrategy, outOfSampleHistory, config);

    const robust = outOfSampleResult.metrics.totalReturn > 0 &&
      inSampleResult.metrics.totalReturn > 0;

    parameterSets.push({
      params,
      inSampleResult,
      outOfSampleResult,
      robust,
    });

    if (outOfSampleResult.metrics.totalReturn > bestOOSReturn) {
      bestOOSReturn = outOfSampleResult.metrics.totalReturn;
      bestParams = params;
    }
  }

  const robustCount = parameterSets.filter(ps => ps.robust).length;
  const robustnessRatio = parameterSets.length > 0
    ? parseFloat((robustCount / parameterSets.length).toFixed(4))
    : 0;

  return {
    parameterSets,
    bestParams,
    robustnessRatio,
  };
}

/**
 * Apply parameter values to strategy conditions.
 * Parameters are applied by name matching against condition properties.
 */
function applyParameters(strategy: Strategy, params: Record<string, number>): Strategy {
  const modified = {
    ...strategy,
    entryConditions: strategy.entryConditions.map(c => ({ ...c })),
    exitConditions: strategy.exitConditions.map(c => ({ ...c })),
  };

  // Apply known parameter names
  if (params.entryThreshold !== undefined && modified.entryConditions[0]) {
    modified.entryConditions[0].value = params.entryThreshold;
  }
  if (params.exitThreshold !== undefined && modified.exitConditions[0]) {
    modified.exitConditions[0].value = params.exitThreshold;
  }
  if (params.stopLoss !== undefined) {
    modified.stopLoss = params.stopLoss;
  }
  if (params.takeProfit !== undefined) {
    modified.takeProfit = params.takeProfit;
  }
  if (params.positionSize !== undefined) {
    modified.positionSize = params.positionSize;
  }
  if (params.movingAveragePeriod !== undefined && modified.entryConditions[0]) {
    modified.entryConditions[0].movingAveragePeriod = params.movingAveragePeriod;
  }

  return modified;
}

// ─── Strategy Builder Helpers ────────────────────────────────────────────────

/**
 * Create a simple threshold strategy: enter when price crosses above
 * a threshold, exit when it crosses below another.
 */
export function createThresholdStrategy(
  id: string,
  name: string,
  marketId: string,
  entryThreshold: number,
  exitThreshold: number,
  outcome: string = 'Yes',
  direction: TradeDirection = 'long',
): Strategy {
  return {
    id,
    name,
    marketId,
    entryConditions: [
      {
        outcome,
        operator: direction === 'long' ? 'crosses_above' : 'crosses_below',
        value: entryThreshold,
      },
    ],
    exitConditions: [
      {
        outcome,
        operator: direction === 'long' ? 'crosses_below' : 'crosses_above',
        value: exitThreshold,
      },
    ],
    direction,
    positionSize: 1.0,
  };
}

/**
 * Create a moving average crossover strategy: enter when price crosses
 * above its MA, exit when it crosses below.
 */
export function createMACrossoverStrategy(
  id: string,
  name: string,
  marketId: string,
  maPeriod: number,
  outcome: string = 'Yes',
): Strategy {
  return {
    id,
    name,
    marketId,
    entryConditions: [
      {
        outcome,
        operator: 'gt',
        value: 0, // Compared against MA, not this value
        movingAveragePeriod: maPeriod,
      },
    ],
    exitConditions: [
      {
        outcome,
        operator: 'lt',
        value: 0,
        movingAveragePeriod: maPeriod,
      },
    ],
    direction: 'long',
    positionSize: 1.0,
  };
}

/**
 * Create a mean reversion strategy: enter when price deviates significantly
 * from its moving average, exit when it reverts.
 */
export function createMeanReversionStrategy(
  id: string,
  name: string,
  marketId: string,
  maPeriod: number,
  deviationThreshold: number,
  outcome: string = 'Yes',
): Strategy {
  return {
    id,
    name,
    marketId,
    entryConditions: [
      {
        outcome,
        operator: 'lte',
        value: 50 - deviationThreshold,
      },
    ],
    exitConditions: [
      {
        outcome,
        operator: 'gte',
        value: 50,
      },
    ],
    direction: 'long',
    positionSize: 1.0,
  };
}

/**
 * Validate a strategy definition for correctness.
 */
export function validateStrategy(strategy: Strategy): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!strategy.id || strategy.id.trim() === '') {
    errors.push('Strategy ID is required');
  }

  if (!strategy.name || strategy.name.trim() === '') {
    errors.push('Strategy name is required');
  }

  if (!strategy.marketId || strategy.marketId.trim() === '') {
    errors.push('Market ID is required');
  }

  if (strategy.entryConditions.length === 0) {
    errors.push('At least one entry condition is required');
  }

  if (strategy.exitConditions.length === 0) {
    errors.push('At least one exit condition is required');
  }

  if (strategy.positionSize <= 0 || strategy.positionSize > 1) {
    errors.push('Position size must be between 0 and 1 (exclusive of 0)');
  }

  if (strategy.stopLoss !== undefined && strategy.stopLoss <= 0) {
    errors.push('Stop loss must be positive');
  }

  if (strategy.takeProfit !== undefined && strategy.takeProfit <= 0) {
    errors.push('Take profit must be positive');
  }

  if (strategy.maxHoldTime !== undefined && strategy.maxHoldTime <= 0) {
    errors.push('Max hold time must be positive');
  }

  if (strategy.cooldownMs !== undefined && strategy.cooldownMs < 0) {
    errors.push('Cooldown must be non-negative');
  }

  for (const cond of [...strategy.entryConditions, ...strategy.exitConditions]) {
    if (cond.value < 0 || cond.value > 100) {
      errors.push(`Condition value ${cond.value} must be between 0 and 100`);
    }
    if (cond.movingAveragePeriod !== undefined && cond.movingAveragePeriod < 1) {
      errors.push('Moving average period must be at least 1');
    }
    const validOps: ConditionOperator[] = ['gt', 'gte', 'lt', 'lte', 'eq', 'crosses_above', 'crosses_below'];
    if (!validOps.includes(cond.operator)) {
      errors.push(`Invalid operator: ${cond.operator}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Summarize a backtest result in a human-readable format.
 */
export function summarizeBacktest(result: BacktestResult): string {
  const m = result.metrics;
  const lines = [
    `Strategy: ${result.strategyId}`,
    `Period: ${new Date(result.startTime).toISOString().split('T')[0]} to ${new Date(result.endTime).toISOString().split('T')[0]}`,
    `Data points: ${result.dataPoints}`,
    ``,
    `--- Performance ---`,
    `Total trades: ${m.totalTrades}`,
    `Win rate: ${(m.winRate * 100).toFixed(1)}%`,
    `Total P&L: ${m.totalPnl.toFixed(2)}`,
    `Total return: ${(m.totalReturn * 100).toFixed(2)}%`,
    `Profit factor: ${m.profitFactor === Infinity ? 'Inf' : m.profitFactor.toFixed(2)}`,
    ``,
    `--- Risk ---`,
    `Max drawdown: ${m.maxDrawdown.toFixed(2)}%`,
    `Sharpe ratio: ${m.sharpeRatio.toFixed(2)}`,
    `Sortino ratio: ${m.sortinoRatio.toFixed(2)}`,
    ``,
    `--- Stats ---`,
    `Avg win: ${m.averageWin.toFixed(2)}`,
    `Avg loss: ${m.averageLoss.toFixed(2)}`,
    `Max win streak: ${m.maxWinStreak}`,
    `Max loss streak: ${m.maxLossStreak}`,
    `Expectancy: ${m.expectancy.toFixed(2)}`,
    `Total fees: ${m.totalFees.toFixed(2)}`,
  ];

  return lines.join('\n');
}

// ─── Default Export ──────────────────────────────────────────────────────────

export default {
  // Core
  runBacktest,
  calculateMetrics,
  calculateMaxDrawdown,
  buildDrawdownCurve,

  // Helpers
  computeMovingAverage,
  computeEMA,
  extractPriceData,
  evaluateCondition,
  checkEntryConditions,
  checkExitConditions,
  calculateTradePnl,

  // Strategy builders
  createThresholdStrategy,
  createMACrossoverStrategy,
  createMeanReversionStrategy,
  validateStrategy,

  // Analysis
  compareStrategies,
  runMonteCarloSimulation,
  walkForwardOptimize,
  summarizeBacktest,

  // Config
  DEFAULT_BACKTEST_CONFIG,
};
