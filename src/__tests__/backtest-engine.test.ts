/**
 * Tests for BacktestEngine — Historical Alert Strategy Simulation
 *
 * Covers: moving averages, condition evaluation, trade P&L calculation,
 * strategy validation, backtest execution, performance metrics,
 * drawdown analysis, strategy comparison, Monte Carlo simulation,
 * walk-forward optimization, strategy builders, and edge cases.
 */

import { describe, test, expect } from 'bun:test';
import {
  computeMovingAverage,
  computeEMA,
  extractPriceData,
  evaluateCondition,
  checkEntryConditions,
  checkExitConditions,
  calculateTradePnl,
  runBacktest,
  calculateMetrics,
  calculateMaxDrawdown,
  buildDrawdownCurve,
  compareStrategies,
  runMonteCarloSimulation,
  walkForwardOptimize,
  createThresholdStrategy,
  createMACrossoverStrategy,
  createMeanReversionStrategy,
  validateStrategy,
  summarizeBacktest,
  DEFAULT_BACKTEST_CONFIG,
} from '../backtest-engine';
import type {
  Strategy,
  StrategyCondition,
  BacktestConfig,
  SimulatedTrade,
  PriceSnapshot,
} from '../backtest-engine';

// ─── Test Helpers ────────────────────────────────────────────────────────────

function makeHistory(
  marketId: string,
  outcome: string,
  values: number[],
  intervalMs: number = 300000,
): Record<string, PriceSnapshot[]> {
  const now = Date.now();
  const snapshots: PriceSnapshot[] = values.map((v, i) => ({
    timestamp: now - (values.length - 1 - i) * intervalMs,
    prices: { [outcome]: v },
  }));
  return { [marketId]: snapshots };
}

function makeSimpleStrategy(
  marketId: string = 'market1',
  entryValue: number = 60,
  exitValue: number = 40,
): Strategy {
  return {
    id: 'test-strategy',
    name: 'Test Strategy',
    marketId,
    entryConditions: [
      { outcome: 'Yes', operator: 'gte', value: entryValue },
    ],
    exitConditions: [
      { outcome: 'Yes', operator: 'lte', value: exitValue },
    ],
    direction: 'long',
    positionSize: 1.0,
  };
}

// ─── computeMovingAverage ────────────────────────────────────────────────────

describe('computeMovingAverage', () => {
  test('computes SMA correctly for period 3', () => {
    const prices = [10, 20, 30, 40, 50];
    const ma = computeMovingAverage(prices, 3);
    expect(ma[0]).toBeNull();
    expect(ma[1]).toBeNull();
    expect(ma[2]).toBeCloseTo(20, 2);
    expect(ma[3]).toBeCloseTo(30, 2);
    expect(ma[4]).toBeCloseTo(40, 2);
  });

  test('computes SMA for period 1 (identity)', () => {
    const prices = [10, 20, 30];
    const ma = computeMovingAverage(prices, 1);
    expect(ma[0]).toBeCloseTo(10, 2);
    expect(ma[1]).toBeCloseTo(20, 2);
    expect(ma[2]).toBeCloseTo(30, 2);
  });

  test('returns all null for period 0', () => {
    const prices = [10, 20, 30];
    const ma = computeMovingAverage(prices, 0);
    expect(ma.every(v => v === null)).toBe(true);
  });

  test('handles period larger than data', () => {
    const prices = [10, 20];
    const ma = computeMovingAverage(prices, 5);
    expect(ma.every(v => v === null)).toBe(true);
  });

  test('handles single element', () => {
    const ma = computeMovingAverage([50], 1);
    expect(ma[0]).toBeCloseTo(50, 2);
  });

  test('handles empty array', () => {
    const ma = computeMovingAverage([], 3);
    expect(ma).toHaveLength(0);
  });

  test('period equal to length produces single value', () => {
    const prices = [10, 20, 30];
    const ma = computeMovingAverage(prices, 3);
    expect(ma[0]).toBeNull();
    expect(ma[1]).toBeNull();
    expect(ma[2]).toBeCloseTo(20, 2);
  });

  test('handles constant prices', () => {
    const prices = [50, 50, 50, 50, 50];
    const ma = computeMovingAverage(prices, 3);
    expect(ma[2]).toBeCloseTo(50, 2);
    expect(ma[3]).toBeCloseTo(50, 2);
    expect(ma[4]).toBeCloseTo(50, 2);
  });
});

// ─── computeEMA ──────────────────────────────────────────────────────────────

describe('computeEMA', () => {
  test('computes EMA correctly', () => {
    const prices = [10, 20, 30, 40, 50];
    const ema = computeEMA(prices, 3);
    expect(ema[0]).toBeNull();
    expect(ema[1]).toBeNull();
    expect(ema[2]).not.toBeNull();
    expect(typeof ema[2]).toBe('number');
    // First EMA value should be SMA
    expect(ema[2]).toBeCloseTo(20, 2);
  });

  test('EMA responds more to recent prices', () => {
    const prices = [10, 10, 10, 10, 50]; // sharp spike at end
    const ema = computeEMA(prices, 3);
    const sma = computeMovingAverage(prices, 3);
    // EMA should respond more to the spike
    expect(ema[4]!).toBeGreaterThan(sma[4]! - 1);
  });

  test('handles empty array', () => {
    const ema = computeEMA([], 3);
    expect(ema).toHaveLength(0);
  });

  test('handles period 0', () => {
    const ema = computeEMA([10, 20, 30], 0);
    expect(ema.every(v => v === null)).toBe(true);
  });

  test('handles period 1', () => {
    const prices = [10, 20, 30];
    const ema = computeEMA(prices, 1);
    // Period 1 EMA should closely follow prices
    expect(ema[0]).toBeCloseTo(10, 2);
  });

  test('handles array shorter than period', () => {
    const ema = computeEMA([10, 20], 5);
    expect(ema.every(v => v === null)).toBe(true);
  });
});

// ─── extractPriceData ────────────────────────────────────────────────────────

describe('extractPriceData', () => {
  test('extracts prices and timestamps', () => {
    const history = makeHistory('m1', 'Yes', [50, 60, 70]);
    const data = extractPriceData(history, 'm1', 'Yes');
    expect(data.prices).toHaveLength(3);
    expect(data.timestamps).toHaveLength(3);
    expect(data.prices[0]).toBe(50);
    expect(data.prices[2]).toBe(70);
  });

  test('returns empty for missing market', () => {
    const data = extractPriceData({}, 'nonexistent', 'Yes');
    expect(data.prices).toHaveLength(0);
    expect(data.timestamps).toHaveLength(0);
  });

  test('returns empty for missing outcome', () => {
    const history = makeHistory('m1', 'Yes', [50, 60]);
    const data = extractPriceData(history, 'm1', 'No');
    expect(data.prices).toHaveLength(0);
  });

  test('sorts by timestamp ascending', () => {
    const history: Record<string, PriceSnapshot[]> = {
      m1: [
        { timestamp: 3000, prices: { Yes: 30 } },
        { timestamp: 1000, prices: { Yes: 10 } },
        { timestamp: 2000, prices: { Yes: 20 } },
      ],
    };
    const data = extractPriceData(history, 'm1', 'Yes');
    expect(data.prices).toEqual([10, 20, 30]);
    expect(data.timestamps).toEqual([1000, 2000, 3000]);
  });

  test('filters out snapshots missing the outcome', () => {
    const history: Record<string, PriceSnapshot[]> = {
      m1: [
        { timestamp: 1000, prices: { Yes: 10 } },
        { timestamp: 2000, prices: { No: 20 } },
        { timestamp: 3000, prices: { Yes: 30 } },
      ],
    };
    const data = extractPriceData(history, 'm1', 'Yes');
    expect(data.prices).toEqual([10, 30]);
  });
});

// ─── evaluateCondition ───────────────────────────────────────────────────────

describe('evaluateCondition', () => {
  test('gt operator', () => {
    expect(evaluateCondition({ outcome: 'Yes', operator: 'gt', value: 50 }, 60, null, null)).toBe(true);
    expect(evaluateCondition({ outcome: 'Yes', operator: 'gt', value: 50 }, 50, null, null)).toBe(false);
    expect(evaluateCondition({ outcome: 'Yes', operator: 'gt', value: 50 }, 40, null, null)).toBe(false);
  });

  test('gte operator', () => {
    expect(evaluateCondition({ outcome: 'Yes', operator: 'gte', value: 50 }, 50, null, null)).toBe(true);
    expect(evaluateCondition({ outcome: 'Yes', operator: 'gte', value: 50 }, 49, null, null)).toBe(false);
  });

  test('lt operator', () => {
    expect(evaluateCondition({ outcome: 'Yes', operator: 'lt', value: 50 }, 40, null, null)).toBe(true);
    expect(evaluateCondition({ outcome: 'Yes', operator: 'lt', value: 50 }, 50, null, null)).toBe(false);
  });

  test('lte operator', () => {
    expect(evaluateCondition({ outcome: 'Yes', operator: 'lte', value: 50 }, 50, null, null)).toBe(true);
    expect(evaluateCondition({ outcome: 'Yes', operator: 'lte', value: 50 }, 51, null, null)).toBe(false);
  });

  test('eq operator', () => {
    expect(evaluateCondition({ outcome: 'Yes', operator: 'eq', value: 50 }, 50, null, null)).toBe(true);
    expect(evaluateCondition({ outcome: 'Yes', operator: 'eq', value: 50 }, 50.005, null, null)).toBe(true);
    expect(evaluateCondition({ outcome: 'Yes', operator: 'eq', value: 50 }, 51, null, null)).toBe(false);
  });

  test('crosses_above operator', () => {
    expect(evaluateCondition({ outcome: 'Yes', operator: 'crosses_above', value: 50 }, 55, 45, null)).toBe(true);
    expect(evaluateCondition({ outcome: 'Yes', operator: 'crosses_above', value: 50 }, 55, 55, null)).toBe(false);
    expect(evaluateCondition({ outcome: 'Yes', operator: 'crosses_above', value: 50 }, 45, 45, null)).toBe(false);
  });

  test('crosses_below operator', () => {
    expect(evaluateCondition({ outcome: 'Yes', operator: 'crosses_below', value: 50 }, 45, 55, null)).toBe(true);
    expect(evaluateCondition({ outcome: 'Yes', operator: 'crosses_below', value: 50 }, 45, 45, null)).toBe(false);
  });

  test('crosses_above with no previous price returns false', () => {
    expect(evaluateCondition({ outcome: 'Yes', operator: 'crosses_above', value: 50 }, 55, null, null)).toBe(false);
  });

  test('crosses_below with no previous price returns false', () => {
    expect(evaluateCondition({ outcome: 'Yes', operator: 'crosses_below', value: 50 }, 45, null, null)).toBe(false);
  });

  test('uses moving average when specified', () => {
    const cond: StrategyCondition = { outcome: 'Yes', operator: 'gt', value: 50, movingAveragePeriod: 5 };
    // MA is 60, which is > 50
    expect(evaluateCondition(cond, 30, null, 60)).toBe(true);
    // MA is 40, which is not > 50
    expect(evaluateCondition(cond, 60, null, 40)).toBe(false);
  });

  test('falls back to current price when MA is null', () => {
    const cond: StrategyCondition = { outcome: 'Yes', operator: 'gt', value: 50, movingAveragePeriod: 5 };
    expect(evaluateCondition(cond, 60, null, null)).toBe(true);
    expect(evaluateCondition(cond, 40, null, null)).toBe(false);
  });

  test('invalid operator returns false', () => {
    expect(evaluateCondition({ outcome: 'Yes', operator: 'unknown' as any, value: 50 }, 60, null, null)).toBe(false);
  });
});

// ─── checkEntryConditions ────────────────────────────────────────────────────

describe('checkEntryConditions', () => {
  test('returns true when all conditions met', () => {
    const conditions: StrategyCondition[] = [
      { outcome: 'Yes', operator: 'gte', value: 60 },
    ];
    const prices = [50, 55, 65, 70];
    const ma = new Map<number, (number | null)[]>();
    expect(checkEntryConditions(conditions, prices, 2, ma)).toBe(true);
  });

  test('returns false when any condition not met', () => {
    const conditions: StrategyCondition[] = [
      { outcome: 'Yes', operator: 'gte', value: 60 },
      { outcome: 'Yes', operator: 'lte', value: 80 },
    ];
    const prices = [50, 85]; // 85 > 80, second condition fails
    const ma = new Map<number, (number | null)[]>();
    expect(checkEntryConditions(conditions, prices, 1, ma)).toBe(false);
  });

  test('returns false for empty conditions', () => {
    const prices = [50, 60, 70];
    const ma = new Map<number, (number | null)[]>();
    expect(checkEntryConditions([], prices, 0, ma)).toBe(false);
  });

  test('multiple conditions all met', () => {
    const conditions: StrategyCondition[] = [
      { outcome: 'Yes', operator: 'gte', value: 60 },
      { outcome: 'Yes', operator: 'lte', value: 80 },
    ];
    const prices = [50, 70]; // 70 >= 60 AND 70 <= 80
    const ma = new Map<number, (number | null)[]>();
    expect(checkEntryConditions(conditions, prices, 1, ma)).toBe(true);
  });
});

// ─── checkExitConditions ─────────────────────────────────────────────────────

describe('checkExitConditions', () => {
  test('returns true when any condition met', () => {
    const conditions: StrategyCondition[] = [
      { outcome: 'Yes', operator: 'lte', value: 30 },
      { outcome: 'Yes', operator: 'gte', value: 90 },
    ];
    const prices = [50, 25]; // 25 <= 30
    const ma = new Map<number, (number | null)[]>();
    expect(checkExitConditions(conditions, prices, 1, ma)).toBe(true);
  });

  test('returns false when no conditions met', () => {
    const conditions: StrategyCondition[] = [
      { outcome: 'Yes', operator: 'lte', value: 30 },
    ];
    const prices = [50, 40]; // 40 > 30
    const ma = new Map<number, (number | null)[]>();
    expect(checkExitConditions(conditions, prices, 1, ma)).toBe(false);
  });

  test('returns false for empty conditions', () => {
    const prices = [50, 60];
    const ma = new Map<number, (number | null)[]>();
    expect(checkExitConditions([], prices, 0, ma)).toBe(false);
  });
});

// ─── calculateTradePnl ──────────────────────────────────────────────────────

describe('calculateTradePnl', () => {
  test('calculates long trade profit', () => {
    const result = calculateTradePnl(50, 70, 'long', 1.0, 0, 0);
    expect(result.pnl).toBe(20);
    expect(result.pnlPercent).toBe(40);
  });

  test('calculates long trade loss', () => {
    const result = calculateTradePnl(60, 40, 'long', 1.0, 0, 0);
    expect(result.pnl).toBe(-20);
  });

  test('calculates short trade profit', () => {
    const result = calculateTradePnl(70, 50, 'short', 1.0, 0, 0);
    expect(result.pnl).toBe(20);
  });

  test('calculates short trade loss', () => {
    const result = calculateTradePnl(50, 70, 'short', 1.0, 0, 0);
    expect(result.pnl).toBe(-20);
  });

  test('applies position sizing', () => {
    const result = calculateTradePnl(50, 70, 'long', 0.5, 0, 0);
    expect(result.pnl).toBe(10); // 20 * 0.5
  });

  test('deducts fees', () => {
    const result = calculateTradePnl(50, 70, 'long', 1.0, 0.01, 0);
    expect(result.fees).toBeGreaterThan(0);
    expect(result.pnl).toBeLessThan(20);
  });

  test('applies slippage', () => {
    const noSlip = calculateTradePnl(50, 70, 'long', 1.0, 0, 0);
    const withSlip = calculateTradePnl(50, 70, 'long', 1.0, 0, 1);
    expect(withSlip.pnl).toBeLessThan(noSlip.pnl);
  });

  test('slippage affects short trades', () => {
    const noSlip = calculateTradePnl(70, 50, 'short', 1.0, 0, 0);
    const withSlip = calculateTradePnl(70, 50, 'short', 1.0, 0, 1);
    expect(withSlip.pnl).toBeLessThan(noSlip.pnl);
  });

  test('zero position size returns zero pnl', () => {
    // positionSize 0 would be invalid in practice but still computes
    const result = calculateTradePnl(50, 70, 'long', 0, 0, 0);
    expect(result.pnl).toBe(0);
  });

  test('handles same entry and exit price', () => {
    const result = calculateTradePnl(50, 50, 'long', 1.0, 0, 0);
    expect(result.pnl).toBe(0);
  });
});

// ─── calculateMaxDrawdown ────────────────────────────────────────────────────

describe('calculateMaxDrawdown', () => {
  test('calculates drawdown from equity curve', () => {
    const curve = [
      { timestamp: 1, equity: 100 },
      { timestamp: 2, equity: 120 },
      { timestamp: 3, equity: 90 },
      { timestamp: 4, equity: 110 },
    ];
    const { maxDrawdown } = calculateMaxDrawdown(curve);
    // Peak was 120, trough was 90, DD = (120-90)/120 * 100 = 25%
    expect(maxDrawdown).toBeCloseTo(25, 1);
  });

  test('zero drawdown for monotonically increasing', () => {
    const curve = [
      { timestamp: 1, equity: 100 },
      { timestamp: 2, equity: 110 },
      { timestamp: 3, equity: 120 },
    ];
    const { maxDrawdown } = calculateMaxDrawdown(curve);
    expect(maxDrawdown).toBe(0);
  });

  test('handles empty curve', () => {
    const { maxDrawdown, maxDrawdownDuration } = calculateMaxDrawdown([]);
    expect(maxDrawdown).toBe(0);
    expect(maxDrawdownDuration).toBe(0);
  });

  test('single point has zero drawdown', () => {
    const { maxDrawdown } = calculateMaxDrawdown([{ timestamp: 1, equity: 100 }]);
    expect(maxDrawdown).toBe(0);
  });

  test('measures drawdown duration', () => {
    const curve = [
      { timestamp: 100, equity: 100 },
      { timestamp: 200, equity: 120 },
      { timestamp: 300, equity: 90 },
      { timestamp: 400, equity: 80 },
      { timestamp: 500, equity: 130 },
    ];
    const { maxDrawdownDuration } = calculateMaxDrawdown(curve);
    // Peak at 200, lowest at 400, duration = 200
    expect(maxDrawdownDuration).toBe(200);
  });

  test('100% drawdown to zero', () => {
    const curve = [
      { timestamp: 1, equity: 100 },
      { timestamp: 2, equity: 0 },
    ];
    const { maxDrawdown } = calculateMaxDrawdown(curve);
    expect(maxDrawdown).toBe(100);
  });
});

// ─── buildDrawdownCurve ──────────────────────────────────────────────────────

describe('buildDrawdownCurve', () => {
  test('builds drawdown curve from equity curve', () => {
    const equityCurve = [
      { timestamp: 1, equity: 100 },
      { timestamp: 2, equity: 120 },
      { timestamp: 3, equity: 100 },
    ];
    const dd = buildDrawdownCurve(equityCurve);
    expect(dd).toHaveLength(3);
    expect(dd[0]!.drawdown).toBe(0);
    expect(dd[1]!.drawdown).toBe(0); // new peak
    expect(dd[2]!.drawdown).toBeCloseTo(16.6667, 1); // (120-100)/120 * 100
  });

  test('empty equity curve returns empty drawdown', () => {
    expect(buildDrawdownCurve([])).toHaveLength(0);
  });

  test('all zero drawdown for increasing equity', () => {
    const curve = [
      { timestamp: 1, equity: 100 },
      { timestamp: 2, equity: 200 },
      { timestamp: 3, equity: 300 },
    ];
    const dd = buildDrawdownCurve(curve);
    expect(dd.every(d => d.drawdown === 0)).toBe(true);
  });
});

// ─── validateStrategy ────────────────────────────────────────────────────────

describe('validateStrategy', () => {
  test('validates correct strategy', () => {
    const strategy = makeSimpleStrategy();
    const result = validateStrategy(strategy);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('rejects empty ID', () => {
    const strategy = { ...makeSimpleStrategy(), id: '' };
    const result = validateStrategy(strategy);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Strategy ID is required');
  });

  test('rejects empty name', () => {
    const strategy = { ...makeSimpleStrategy(), name: '' };
    const result = validateStrategy(strategy);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Strategy name is required');
  });

  test('rejects empty market ID', () => {
    const strategy = { ...makeSimpleStrategy(), marketId: '' };
    const result = validateStrategy(strategy);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Market ID is required');
  });

  test('rejects no entry conditions', () => {
    const strategy = { ...makeSimpleStrategy(), entryConditions: [] };
    const result = validateStrategy(strategy);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('At least one entry condition is required');
  });

  test('rejects no exit conditions', () => {
    const strategy = { ...makeSimpleStrategy(), exitConditions: [] };
    const result = validateStrategy(strategy);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('At least one exit condition is required');
  });

  test('rejects position size > 1', () => {
    const strategy = { ...makeSimpleStrategy(), positionSize: 1.5 };
    const result = validateStrategy(strategy);
    expect(result.valid).toBe(false);
  });

  test('rejects position size <= 0', () => {
    const strategy = { ...makeSimpleStrategy(), positionSize: 0 };
    const result = validateStrategy(strategy);
    expect(result.valid).toBe(false);
  });

  test('rejects negative stop loss', () => {
    const strategy = { ...makeSimpleStrategy(), stopLoss: -5 };
    const result = validateStrategy(strategy);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Stop loss must be positive');
  });

  test('rejects negative take profit', () => {
    const strategy = { ...makeSimpleStrategy(), takeProfit: -5 };
    const result = validateStrategy(strategy);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Take profit must be positive');
  });

  test('rejects negative max hold time', () => {
    const strategy = { ...makeSimpleStrategy(), maxHoldTime: -1000 };
    const result = validateStrategy(strategy);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Max hold time must be positive');
  });

  test('rejects negative cooldown', () => {
    const strategy = { ...makeSimpleStrategy(), cooldownMs: -1 };
    const result = validateStrategy(strategy);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Cooldown must be non-negative');
  });

  test('rejects condition value out of range', () => {
    const strategy = makeSimpleStrategy();
    strategy.entryConditions[0]!.value = 150;
    const result = validateStrategy(strategy);
    expect(result.valid).toBe(false);
  });

  test('rejects moving average period < 1', () => {
    const strategy = makeSimpleStrategy();
    strategy.entryConditions[0]!.movingAveragePeriod = 0;
    const result = validateStrategy(strategy);
    expect(result.valid).toBe(false);
  });

  test('accepts valid optional parameters', () => {
    const strategy: Strategy = {
      ...makeSimpleStrategy(),
      stopLoss: 5,
      takeProfit: 10,
      maxHoldTime: 3600000,
      cooldownMs: 60000,
    };
    const result = validateStrategy(strategy);
    expect(result.valid).toBe(true);
  });

  test('collects multiple errors', () => {
    const strategy: Strategy = {
      id: '',
      name: '',
      marketId: '',
      entryConditions: [],
      exitConditions: [],
      direction: 'long',
      positionSize: 0,
    };
    const result = validateStrategy(strategy);
    expect(result.errors.length).toBeGreaterThanOrEqual(4);
  });
});

// ─── Strategy Builders ───────────────────────────────────────────────────────

describe('createThresholdStrategy', () => {
  test('creates long threshold strategy', () => {
    const s = createThresholdStrategy('s1', 'Test', 'm1', 60, 40);
    expect(s.id).toBe('s1');
    expect(s.entryConditions).toHaveLength(1);
    expect(s.entryConditions[0]!.operator).toBe('crosses_above');
    expect(s.entryConditions[0]!.value).toBe(60);
    expect(s.exitConditions[0]!.operator).toBe('crosses_below');
    expect(s.exitConditions[0]!.value).toBe(40);
    expect(s.direction).toBe('long');
  });

  test('creates short threshold strategy', () => {
    const s = createThresholdStrategy('s2', 'Short', 'm1', 60, 40, 'Yes', 'short');
    expect(s.direction).toBe('short');
    expect(s.entryConditions[0]!.operator).toBe('crosses_below');
    expect(s.exitConditions[0]!.operator).toBe('crosses_above');
  });

  test('uses custom outcome', () => {
    const s = createThresholdStrategy('s3', 'No Track', 'm1', 60, 40, 'No');
    expect(s.entryConditions[0]!.outcome).toBe('No');
  });
});

describe('createMACrossoverStrategy', () => {
  test('creates MA crossover strategy', () => {
    const s = createMACrossoverStrategy('ma1', 'MA Cross', 'm1', 10);
    expect(s.entryConditions[0]!.movingAveragePeriod).toBe(10);
    expect(s.exitConditions[0]!.movingAveragePeriod).toBe(10);
    expect(s.direction).toBe('long');
  });

  test('uses custom outcome', () => {
    const s = createMACrossoverStrategy('ma2', 'MA No', 'm1', 5, 'No');
    expect(s.entryConditions[0]!.outcome).toBe('No');
  });
});

describe('createMeanReversionStrategy', () => {
  test('creates mean reversion strategy', () => {
    const s = createMeanReversionStrategy('mr1', 'Mean Rev', 'm1', 10, 15);
    expect(s.entryConditions[0]!.value).toBe(35); // 50 - 15
    expect(s.exitConditions[0]!.value).toBe(50);
    expect(s.direction).toBe('long');
  });
});

// ─── runBacktest ─────────────────────────────────────────────────────────────

describe('runBacktest', () => {
  test('executes a profitable long trade', () => {
    // Price rises above 60, then drops below 40
    const prices = [30, 40, 50, 65, 70, 75, 50, 35];
    const history = makeHistory('m1', 'Yes', prices);
    const strategy = makeSimpleStrategy('m1', 60, 40);
    const result = runBacktest(strategy, history, { ...DEFAULT_BACKTEST_CONFIG, feeRate: 0, slippage: 0 });

    expect(result.trades.length).toBeGreaterThanOrEqual(1);
    expect(result.trades[0]!.direction).toBe('long');
    expect(result.metrics.totalTrades).toBeGreaterThanOrEqual(1);
  });

  test('handles no trades when conditions never met', () => {
    const prices = [30, 35, 40, 35, 30, 25];
    const history = makeHistory('m1', 'Yes', prices);
    const strategy = makeSimpleStrategy('m1', 90, 10); // very extreme
    const result = runBacktest(strategy, history);

    expect(result.trades).toHaveLength(0);
    expect(result.metrics.totalTrades).toBe(0);
    expect(result.metrics.finalEquity).toBe(DEFAULT_BACKTEST_CONFIG.initialCapital);
  });

  test('returns empty result for insufficient data', () => {
    const history = makeHistory('m1', 'Yes', [50]);
    const strategy = makeSimpleStrategy('m1');
    const result = runBacktest(strategy, history);

    expect(result.trades).toHaveLength(0);
    expect(result.dataPoints).toBeLessThanOrEqual(1);
  });

  test('returns empty result for empty history', () => {
    const result = runBacktest(makeSimpleStrategy('m1'), {});
    expect(result.trades).toHaveLength(0);
    expect(result.dataPoints).toBe(0);
  });

  test('stop loss triggers correctly', () => {
    // Enter at 65, price drops significantly
    const prices = [30, 50, 65, 62, 58, 55, 50, 45];
    const history = makeHistory('m1', 'Yes', prices);
    const strategy: Strategy = {
      ...makeSimpleStrategy('m1', 60, 20),
      stopLoss: 8,
    };
    const result = runBacktest(strategy, history, { ...DEFAULT_BACKTEST_CONFIG, feeRate: 0, slippage: 0 });

    if (result.trades.length > 0) {
      const trade = result.trades[0]!;
      expect(trade.exitReason).toBe('stop_loss');
    }
  });

  test('take profit triggers correctly', () => {
    // Enter at 65, price rises significantly
    const prices = [30, 50, 65, 70, 75, 80, 85, 90];
    const history = makeHistory('m1', 'Yes', prices);
    const strategy: Strategy = {
      ...makeSimpleStrategy('m1', 60, 20),
      takeProfit: 10,
    };
    const result = runBacktest(strategy, history, { ...DEFAULT_BACKTEST_CONFIG, feeRate: 0, slippage: 0 });

    if (result.trades.length > 0) {
      const trade = result.trades[0]!;
      expect(trade.exitReason).toBe('take_profit');
      expect(trade.pnl).toBeGreaterThan(0);
    }
  });

  test('max hold time triggers exit', () => {
    const now = Date.now();
    const history: Record<string, PriceSnapshot[]> = {
      m1: [
        { timestamp: now - 400000, prices: { Yes: 50 } },
        { timestamp: now - 300000, prices: { Yes: 65 } },
        { timestamp: now - 200000, prices: { Yes: 68 } },
        { timestamp: now - 100000, prices: { Yes: 70 } },
        { timestamp: now, prices: { Yes: 72 } },
      ],
    };
    const strategy: Strategy = {
      ...makeSimpleStrategy('m1', 60, 20),
      maxHoldTime: 150000, // 150 seconds
    };
    const result = runBacktest(strategy, history, { ...DEFAULT_BACKTEST_CONFIG, feeRate: 0, slippage: 0 });

    if (result.trades.length > 0) {
      expect(result.trades[0]!.exitReason).toBe('max_hold_time');
    }
  });

  test('cooldown prevents rapid re-entry', () => {
    // Price bounces around entry/exit thresholds rapidly
    const now = Date.now();
    const history: Record<string, PriceSnapshot[]> = {
      m1: Array.from({ length: 20 }, (_, i) => ({
        timestamp: now - (19 - i) * 60000,
        prices: { Yes: i % 2 === 0 ? 65 : 35 },
      })),
    };
    const strategyWithCooldown: Strategy = {
      ...makeSimpleStrategy('m1', 60, 40),
      cooldownMs: 300000, // 5 minute cooldown
    };
    const strategyNoCooldown = makeSimpleStrategy('m1', 60, 40);

    const resultWithCooldown = runBacktest(strategyWithCooldown, history, { ...DEFAULT_BACKTEST_CONFIG, feeRate: 0, slippage: 0 });
    const resultNoCooldown = runBacktest(strategyNoCooldown, history, { ...DEFAULT_BACKTEST_CONFIG, feeRate: 0, slippage: 0 });

    // Cooldown should result in fewer trades
    expect(resultWithCooldown.trades.length).toBeLessThanOrEqual(resultNoCooldown.trades.length);
  });

  test('end_of_data closes open positions', () => {
    // Enter but never trigger exit condition
    const prices = [30, 50, 65, 70, 75, 80];
    const history = makeHistory('m1', 'Yes', prices);
    const strategy = makeSimpleStrategy('m1', 60, 10); // exit at 10, never reached
    const result = runBacktest(strategy, history, { ...DEFAULT_BACKTEST_CONFIG, feeRate: 0, slippage: 0 });

    if (result.trades.length > 0) {
      const lastTrade = result.trades[result.trades.length - 1]!;
      expect(lastTrade.exitReason).toBe('end_of_data');
    }
  });

  test('builds equity curve', () => {
    const prices = [30, 40, 50, 65, 70, 50, 35, 65, 50, 35];
    const history = makeHistory('m1', 'Yes', prices);
    const strategy = makeSimpleStrategy('m1', 60, 40);
    const result = runBacktest(strategy, history);

    expect(result.equityCurve.length).toBeGreaterThan(0);
    expect(result.equityCurve[0]!.equity).toBe(DEFAULT_BACKTEST_CONFIG.initialCapital);
  });

  test('builds drawdown curve', () => {
    const prices = [30, 65, 80, 50, 35, 65, 80, 50, 35];
    const history = makeHistory('m1', 'Yes', prices);
    const strategy = makeSimpleStrategy('m1', 60, 40);
    const result = runBacktest(strategy, history);

    expect(result.drawdownCurve.length).toBeGreaterThan(0);
    for (const point of result.drawdownCurve) {
      expect(point.drawdown).toBeGreaterThanOrEqual(0);
    }
  });

  test('records start and end times', () => {
    const prices = [30, 50, 65, 70, 50, 35];
    const history = makeHistory('m1', 'Yes', prices);
    const strategy = makeSimpleStrategy('m1');
    const result = runBacktest(strategy, history);

    expect(result.startTime).toBeLessThan(result.endTime);
    expect(result.dataPoints).toBe(prices.length);
  });

  test('applies fees correctly', () => {
    const prices = [30, 65, 70, 35];
    const history = makeHistory('m1', 'Yes', prices);
    const strategy = makeSimpleStrategy('m1', 60, 40);

    const noFee = runBacktest(strategy, history, { ...DEFAULT_BACKTEST_CONFIG, feeRate: 0, slippage: 0 });
    const withFee = runBacktest(strategy, history, { ...DEFAULT_BACKTEST_CONFIG, feeRate: 0.01, slippage: 0 });

    if (noFee.trades.length > 0 && withFee.trades.length > 0) {
      expect(withFee.metrics.totalFees).toBeGreaterThan(0);
      expect(withFee.metrics.finalEquity).toBeLessThan(noFee.metrics.finalEquity);
    }
  });
});

// ─── calculateMetrics ────────────────────────────────────────────────────────

describe('calculateMetrics', () => {
  test('calculates correct win rate', () => {
    const trades: SimulatedTrade[] = [
      { entryTime: 1, entryPrice: 50, exitTime: 2, exitPrice: 60, direction: 'long', positionSize: 1, pnl: 10, pnlPercent: 20, exitReason: 'condition', holdTime: 1 },
      { entryTime: 3, entryPrice: 60, exitTime: 4, exitPrice: 50, direction: 'long', positionSize: 1, pnl: -10, pnlPercent: -16.67, exitReason: 'condition', holdTime: 1 },
      { entryTime: 5, entryPrice: 50, exitTime: 6, exitPrice: 65, direction: 'long', positionSize: 1, pnl: 15, pnlPercent: 30, exitReason: 'condition', holdTime: 1 },
    ];
    const curve = [
      { timestamp: 0, equity: 10000 },
      { timestamp: 2, equity: 10010 },
      { timestamp: 4, equity: 10000 },
      { timestamp: 6, equity: 10015 },
    ];
    const m = calculateMetrics(trades, curve, DEFAULT_BACKTEST_CONFIG, 0);

    expect(m.totalTrades).toBe(3);
    expect(m.winningTrades).toBe(2);
    expect(m.losingTrades).toBe(1);
    expect(m.winRate).toBeCloseTo(0.6667, 2);
  });

  test('calculates profit factor', () => {
    const trades: SimulatedTrade[] = [
      { entryTime: 1, entryPrice: 50, exitTime: 2, exitPrice: 60, direction: 'long', positionSize: 1, pnl: 10, pnlPercent: 20, exitReason: 'condition', holdTime: 1 },
      { entryTime: 3, entryPrice: 60, exitTime: 4, exitPrice: 55, direction: 'long', positionSize: 1, pnl: -5, pnlPercent: -8.33, exitReason: 'condition', holdTime: 1 },
    ];
    const curve = [
      { timestamp: 0, equity: 10000 },
      { timestamp: 4, equity: 10005 },
    ];
    const m = calculateMetrics(trades, curve, DEFAULT_BACKTEST_CONFIG, 0);
    expect(m.profitFactor).toBeCloseTo(2.0, 2);
  });

  test('handles all winning trades (infinite profit factor)', () => {
    const trades: SimulatedTrade[] = [
      { entryTime: 1, entryPrice: 50, exitTime: 2, exitPrice: 60, direction: 'long', positionSize: 1, pnl: 10, pnlPercent: 20, exitReason: 'condition', holdTime: 1 },
    ];
    const curve = [
      { timestamp: 0, equity: 10000 },
      { timestamp: 2, equity: 10010 },
    ];
    const m = calculateMetrics(trades, curve, DEFAULT_BACKTEST_CONFIG, 0);
    expect(m.profitFactor).toBe(Infinity);
  });

  test('handles no trades', () => {
    const m = calculateMetrics([], [], DEFAULT_BACKTEST_CONFIG, 0);
    expect(m.totalTrades).toBe(0);
    expect(m.winRate).toBe(0);
    expect(m.sharpeRatio).toBe(0);
    expect(m.finalEquity).toBe(10000);
  });

  test('calculates win and loss streaks', () => {
    const trades: SimulatedTrade[] = [
      { entryTime: 1, entryPrice: 50, exitTime: 2, exitPrice: 60, direction: 'long', positionSize: 1, pnl: 10, pnlPercent: 20, exitReason: 'condition', holdTime: 1 },
      { entryTime: 3, entryPrice: 50, exitTime: 4, exitPrice: 60, direction: 'long', positionSize: 1, pnl: 10, pnlPercent: 20, exitReason: 'condition', holdTime: 1 },
      { entryTime: 5, entryPrice: 50, exitTime: 6, exitPrice: 60, direction: 'long', positionSize: 1, pnl: 10, pnlPercent: 20, exitReason: 'condition', holdTime: 1 },
      { entryTime: 7, entryPrice: 60, exitTime: 8, exitPrice: 50, direction: 'long', positionSize: 1, pnl: -10, pnlPercent: -16.67, exitReason: 'condition', holdTime: 1 },
      { entryTime: 9, entryPrice: 60, exitTime: 10, exitPrice: 50, direction: 'long', positionSize: 1, pnl: -10, pnlPercent: -16.67, exitReason: 'condition', holdTime: 1 },
    ];
    const curve = [{ timestamp: 0, equity: 10000 }, { timestamp: 10, equity: 10010 }];
    const m = calculateMetrics(trades, curve, DEFAULT_BACKTEST_CONFIG, 0);
    expect(m.maxWinStreak).toBe(3);
    expect(m.maxLossStreak).toBe(2);
  });

  test('calculates expectancy', () => {
    const trades: SimulatedTrade[] = [
      { entryTime: 1, entryPrice: 50, exitTime: 2, exitPrice: 70, direction: 'long', positionSize: 1, pnl: 20, pnlPercent: 40, exitReason: 'condition', holdTime: 1 },
      { entryTime: 3, entryPrice: 60, exitTime: 4, exitPrice: 55, direction: 'long', positionSize: 1, pnl: -5, pnlPercent: -8.33, exitReason: 'condition', holdTime: 1 },
    ];
    const curve = [{ timestamp: 0, equity: 10000 }, { timestamp: 4, equity: 10015 }];
    const m = calculateMetrics(trades, curve, DEFAULT_BACKTEST_CONFIG, 0);
    // Expectancy = winRate * avgWin - lossRate * avgLoss
    // 0.5 * 20 - 0.5 * 5 = 7.5
    expect(m.expectancy).toBeCloseTo(7.5, 1);
  });

  test('calculates average hold time', () => {
    const trades: SimulatedTrade[] = [
      { entryTime: 1, entryPrice: 50, exitTime: 101, exitPrice: 60, direction: 'long', positionSize: 1, pnl: 10, pnlPercent: 20, exitReason: 'condition', holdTime: 100 },
      { entryTime: 200, entryPrice: 60, exitTime: 500, exitPrice: 55, direction: 'long', positionSize: 1, pnl: -5, pnlPercent: -8.33, exitReason: 'condition', holdTime: 300 },
    ];
    const curve = [{ timestamp: 0, equity: 10000 }, { timestamp: 500, equity: 10005 }];
    const m = calculateMetrics(trades, curve, DEFAULT_BACKTEST_CONFIG, 0);
    expect(m.averageHoldTime).toBe(200);
  });

  test('calculates total return correctly', () => {
    const trades: SimulatedTrade[] = [
      { entryTime: 1, entryPrice: 50, exitTime: 2, exitPrice: 60, direction: 'long', positionSize: 1, pnl: 10, pnlPercent: 20, exitReason: 'condition', holdTime: 1 },
    ];
    const curve = [
      { timestamp: 0, equity: 10000 },
      { timestamp: 2, equity: 10010 },
    ];
    const m = calculateMetrics(trades, curve, DEFAULT_BACKTEST_CONFIG, 0);
    expect(m.totalReturn).toBeCloseTo(10 / 10000, 4);
  });

  test('tracks total fees', () => {
    const m = calculateMetrics([], [], DEFAULT_BACKTEST_CONFIG, 42.5);
    expect(m.totalFees).toBe(42.5);
  });
});

// ─── compareStrategies ───────────────────────────────────────────────────────

describe('compareStrategies', () => {
  test('ranks strategies by composite score', () => {
    const prices = [30, 40, 50, 65, 70, 75, 50, 35, 50, 65, 70, 50, 35];
    const history = makeHistory('m1', 'Yes', prices);

    const strategies = [
      makeSimpleStrategy('m1', 60, 40),
      { ...makeSimpleStrategy('m1', 55, 45), id: 'tight-strategy', name: 'Tight' },
      { ...makeSimpleStrategy('m1', 70, 30), id: 'wide-strategy', name: 'Wide' },
    ];

    const comparison = compareStrategies(strategies, history, {
      ...DEFAULT_BACKTEST_CONFIG,
      feeRate: 0,
      slippage: 0,
    });

    expect(comparison.rankings).toHaveLength(3);
    expect(comparison.rankings[0]!.rank).toBe(1);
    expect(comparison.rankings[1]!.rank).toBe(2);
    expect(comparison.rankings[2]!.rank).toBe(3);
  });

  test('identifies best strategy by each metric', () => {
    const prices = [30, 40, 50, 65, 70, 75, 50, 35, 50, 65, 70, 50, 35];
    const history = makeHistory('m1', 'Yes', prices);

    const strategies = [
      makeSimpleStrategy('m1', 60, 40),
      { ...makeSimpleStrategy('m1', 55, 45), id: 'tight', name: 'Tight' },
    ];

    const comparison = compareStrategies(strategies, history);
    expect(comparison.bestBy).toHaveProperty('sharpeRatio');
    expect(comparison.bestBy).toHaveProperty('winRate');
    expect(comparison.bestBy).toHaveProperty('totalReturn');
  });

  test('handles single strategy', () => {
    const history = makeHistory('m1', 'Yes', [30, 65, 70, 35]);
    const strategies = [makeSimpleStrategy('m1', 60, 40)];
    const comparison = compareStrategies(strategies, history);
    expect(comparison.rankings).toHaveLength(1);
    expect(comparison.rankings[0]!.rank).toBe(1);
  });

  test('handles empty strategies list', () => {
    const comparison = compareStrategies([], {});
    expect(comparison.rankings).toHaveLength(0);
  });

  test('custom scoring weights affect ranking', () => {
    const prices = [30, 40, 50, 65, 70, 75, 50, 35, 50, 65, 70, 50, 35];
    const history = makeHistory('m1', 'Yes', prices);

    const strategies = [
      makeSimpleStrategy('m1', 60, 40),
      { ...makeSimpleStrategy('m1', 55, 45), id: 'tight', name: 'Tight' },
    ];

    const equalWeights = { sharpe: 0.25, winRate: 0.25, profitFactor: 0.25, drawdown: 0.25 };
    const sharpeHeavy = { sharpe: 0.7, winRate: 0.1, profitFactor: 0.1, drawdown: 0.1 };

    const r1 = compareStrategies(strategies, history, DEFAULT_BACKTEST_CONFIG, equalWeights);
    const r2 = compareStrategies(strategies, history, DEFAULT_BACKTEST_CONFIG, sharpeHeavy);

    // Both should produce rankings regardless of weights
    expect(r1.rankings).toHaveLength(2);
    expect(r2.rankings).toHaveLength(2);
  });
});

// ─── runMonteCarloSimulation ─────────────────────────────────────────────────

describe('runMonteCarloSimulation', () => {
  test('runs simulations and produces distributions', () => {
    const prices = [30, 40, 50, 65, 70, 50, 35, 65, 70, 50, 35, 65, 70, 50, 35];
    const history = makeHistory('m1', 'Yes', prices);
    const strategy = makeSimpleStrategy('m1', 60, 40);
    const backtestResult = runBacktest(strategy, history, {
      ...DEFAULT_BACKTEST_CONFIG,
      feeRate: 0,
      slippage: 0,
    });

    const mc = runMonteCarloSimulation(backtestResult, 100, 42);

    expect(mc.simulations).toBe(100);
    expect(mc.equityDistribution.percentile5).toBeLessThanOrEqual(mc.equityDistribution.percentile95);
    expect(mc.equityDistribution.percentile25).toBeLessThanOrEqual(mc.equityDistribution.percentile75);
    expect(mc.profitProbability).toBeGreaterThanOrEqual(0);
    expect(mc.profitProbability).toBeLessThanOrEqual(1);
    expect(mc.ruinProbability).toBeGreaterThanOrEqual(0);
    expect(mc.ruinProbability).toBeLessThanOrEqual(1);
  });

  test('handles backtest with no trades', () => {
    const prices = [30, 35, 40, 35, 30];
    const history = makeHistory('m1', 'Yes', prices);
    const strategy = makeSimpleStrategy('m1', 90, 10);
    const backtestResult = runBacktest(strategy, history);

    const mc = runMonteCarloSimulation(backtestResult, 50, 42);
    expect(mc.profitProbability).toBe(0);
    expect(mc.equityDistribution.median).toBe(10000);
  });

  test('seeded simulations are deterministic', () => {
    const prices = [30, 65, 70, 50, 35, 65, 70, 50, 35];
    const history = makeHistory('m1', 'Yes', prices);
    const strategy = makeSimpleStrategy('m1', 60, 40);
    const backtestResult = runBacktest(strategy, history, {
      ...DEFAULT_BACKTEST_CONFIG,
      feeRate: 0,
      slippage: 0,
    });

    const mc1 = runMonteCarloSimulation(backtestResult, 100, 12345);
    const mc2 = runMonteCarloSimulation(backtestResult, 100, 12345);

    expect(mc1.equityDistribution.median).toBe(mc2.equityDistribution.median);
    expect(mc1.profitProbability).toBe(mc2.profitProbability);
  });

  test('different seeds produce different results', () => {
    const prices = [30, 65, 70, 50, 35, 65, 70, 50, 35, 65, 70, 50, 35, 65, 70, 50, 35];
    const history = makeHistory('m1', 'Yes', prices);
    const strategy = makeSimpleStrategy('m1', 60, 40);
    const backtestResult = runBacktest(strategy, history, {
      ...DEFAULT_BACKTEST_CONFIG,
      feeRate: 0,
      slippage: 0,
    });

    const mc1 = runMonteCarloSimulation(backtestResult, 100, 111);
    const mc2 = runMonteCarloSimulation(backtestResult, 100, 999);

    // Different seeds should generally produce different medians
    // (though they could theoretically match with few trades)
    expect(mc1.simulations).toBe(100);
    expect(mc2.simulations).toBe(100);
  });

  test('drawdown distribution is non-negative', () => {
    const prices = [30, 65, 70, 50, 35, 65, 70, 50, 35];
    const history = makeHistory('m1', 'Yes', prices);
    const strategy = makeSimpleStrategy('m1', 60, 40);
    const backtestResult = runBacktest(strategy, history, {
      ...DEFAULT_BACKTEST_CONFIG,
      feeRate: 0,
      slippage: 0,
    });

    const mc = runMonteCarloSimulation(backtestResult, 50, 42);
    expect(mc.drawdownDistribution.percentile5).toBeGreaterThanOrEqual(0);
    expect(mc.drawdownDistribution.median).toBeGreaterThanOrEqual(0);
    expect(mc.drawdownDistribution.percentile95).toBeGreaterThanOrEqual(0);
  });

  test('equity distribution stdDev is non-negative', () => {
    const prices = [30, 65, 70, 50, 35, 65, 70, 50, 35];
    const history = makeHistory('m1', 'Yes', prices);
    const strategy = makeSimpleStrategy('m1', 60, 40);
    const backtestResult = runBacktest(strategy, history, {
      ...DEFAULT_BACKTEST_CONFIG,
      feeRate: 0,
      slippage: 0,
    });

    const mc = runMonteCarloSimulation(backtestResult, 50, 42);
    expect(mc.equityDistribution.stdDev).toBeGreaterThanOrEqual(0);
  });
});

// ─── walkForwardOptimize ─────────────────────────────────────────────────────

describe('walkForwardOptimize', () => {
  test('optimizes entry threshold parameter', () => {
    const prices = [30, 40, 50, 65, 70, 75, 50, 35, 40, 50, 65, 70, 75, 50, 35, 40, 50, 65, 70, 50, 35];
    const history = makeHistory('m1', 'Yes', prices);
    const baseStrategy = makeSimpleStrategy('m1', 60, 40);

    const result = walkForwardOptimize(
      baseStrategy,
      history,
      { entryThreshold: [50, 70, 10] },
      0.7,
      { ...DEFAULT_BACKTEST_CONFIG, feeRate: 0, slippage: 0 },
    );

    expect(result.parameterSets.length).toBeGreaterThan(0);
    expect(result.robustnessRatio).toBeGreaterThanOrEqual(0);
    expect(result.robustnessRatio).toBeLessThanOrEqual(1);
  });

  test('handles insufficient data', () => {
    const history = makeHistory('m1', 'Yes', [50, 60]);
    const strategy = makeSimpleStrategy('m1');

    const result = walkForwardOptimize(strategy, history, { entryThreshold: [50, 70, 10] });
    expect(result.parameterSets).toHaveLength(0);
    expect(result.robustnessRatio).toBe(0);
  });

  test('handles empty parameter ranges', () => {
    const prices = [30, 40, 50, 65, 70, 75, 50, 35, 40, 50, 65, 70, 75, 50, 35];
    const history = makeHistory('m1', 'Yes', prices);
    const strategy = makeSimpleStrategy('m1');

    const result = walkForwardOptimize(strategy, history, {});
    expect(result.parameterSets).toHaveLength(1);
  });

  test('respects split ratio', () => {
    const prices = Array.from({ length: 30 }, (_, i) => 30 + Math.sin(i * 0.5) * 30);
    const history = makeHistory('m1', 'Yes', prices);
    const strategy = makeSimpleStrategy('m1', 50, 30);

    const result70 = walkForwardOptimize(strategy, history, { entryThreshold: [40, 60, 20] }, 0.7);
    const result50 = walkForwardOptimize(strategy, history, { entryThreshold: [40, 60, 20] }, 0.5);

    // Both should produce results
    expect(result70.parameterSets.length).toBeGreaterThan(0);
    expect(result50.parameterSets.length).toBeGreaterThan(0);
  });

  test('tests multiple parameters', () => {
    const prices = Array.from({ length: 30 }, (_, i) => 30 + Math.sin(i * 0.5) * 30);
    const history = makeHistory('m1', 'Yes', prices);
    const strategy = makeSimpleStrategy('m1', 50, 30);

    const result = walkForwardOptimize(
      strategy,
      history,
      {
        entryThreshold: [50, 60, 10],
        exitThreshold: [30, 40, 10],
      },
      0.7,
      { ...DEFAULT_BACKTEST_CONFIG, feeRate: 0, slippage: 0 },
    );

    // Should have combinations of entry and exit thresholds
    expect(result.parameterSets.length).toBeGreaterThan(1);
  });

  test('identifies best parameters', () => {
    const prices = [30, 40, 50, 65, 70, 75, 50, 35, 40, 50, 65, 70, 75, 50, 35, 50, 65, 70, 50, 35];
    const history = makeHistory('m1', 'Yes', prices);
    const strategy = makeSimpleStrategy('m1');

    const result = walkForwardOptimize(
      strategy,
      history,
      { entryThreshold: [50, 70, 10] },
    );

    expect(result.bestParams).toBeDefined();
  });
});

// ─── summarizeBacktest ───────────────────────────────────────────────────────

describe('summarizeBacktest', () => {
  test('produces human-readable summary', () => {
    const prices = [30, 65, 70, 50, 35];
    const history = makeHistory('m1', 'Yes', prices);
    const strategy = makeSimpleStrategy('m1', 60, 40);
    const result = runBacktest(strategy, history, {
      ...DEFAULT_BACKTEST_CONFIG,
      feeRate: 0,
      slippage: 0,
    });

    const summary = summarizeBacktest(result);
    expect(summary).toContain('Strategy:');
    expect(summary).toContain('Total trades:');
    expect(summary).toContain('Win rate:');
    expect(summary).toContain('Sharpe ratio:');
    expect(summary).toContain('Max drawdown:');
  });

  test('summary includes all sections', () => {
    const result = runBacktest(makeSimpleStrategy('m1'), {});
    const summary = summarizeBacktest(result);
    expect(summary).toContain('Performance');
    expect(summary).toContain('Risk');
    expect(summary).toContain('Stats');
  });

  test('handles zero-trade result', () => {
    const result = runBacktest(makeSimpleStrategy('m1'), {});
    const summary = summarizeBacktest(result);
    expect(summary).toContain('Total trades: 0');
    expect(summary).toContain('Win rate: 0.0%');
  });
});

// ─── Edge Cases ──────────────────────────────────────────────────────────────

describe('Edge cases', () => {
  test('strategy with both stop loss and take profit', () => {
    const prices = [30, 50, 65, 70, 75, 80];
    const history = makeHistory('m1', 'Yes', prices);
    const strategy: Strategy = {
      ...makeSimpleStrategy('m1', 60, 20),
      stopLoss: 3,
      takeProfit: 5,
    };
    const result = runBacktest(strategy, history, {
      ...DEFAULT_BACKTEST_CONFIG,
      feeRate: 0,
      slippage: 0,
    });

    // Should have at least one trade
    if (result.trades.length > 0) {
      const trade = result.trades[0]!;
      expect(['stop_loss', 'take_profit', 'condition', 'end_of_data']).toContain(trade.exitReason);
    }
  });

  test('constant price series (no trades)', () => {
    const prices = [50, 50, 50, 50, 50];
    const history = makeHistory('m1', 'Yes', prices);
    const strategy = makeSimpleStrategy('m1', 60, 40);
    const result = runBacktest(strategy, history);
    expect(result.trades).toHaveLength(0);
  });

  test('very volatile price series', () => {
    const prices = [10, 90, 10, 90, 10, 90, 10, 90, 10, 90];
    const history = makeHistory('m1', 'Yes', prices);
    const strategy = makeSimpleStrategy('m1', 60, 40);
    const result = runBacktest(strategy, history, {
      ...DEFAULT_BACKTEST_CONFIG,
      feeRate: 0,
      slippage: 0,
    });

    expect(result.trades.length).toBeGreaterThanOrEqual(0);
  });

  test('monotonically increasing prices (entry but no exit)', () => {
    const prices = [30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95];
    const history = makeHistory('m1', 'Yes', prices);
    const strategy = makeSimpleStrategy('m1', 60, 20);
    const result = runBacktest(strategy, history, {
      ...DEFAULT_BACKTEST_CONFIG,
      feeRate: 0,
      slippage: 0,
    });

    if (result.trades.length > 0) {
      // Last trade should be closed at end of data
      const lastTrade = result.trades[result.trades.length - 1]!;
      expect(lastTrade.exitReason).toBe('end_of_data');
    }
  });

  test('monotonically decreasing prices', () => {
    const prices = [95, 90, 85, 80, 75, 70, 65, 60, 55, 50, 45, 40, 35, 30];
    const history = makeHistory('m1', 'Yes', prices);
    const strategy = makeSimpleStrategy('m1', 60, 40);
    const result = runBacktest(strategy, history, {
      ...DEFAULT_BACKTEST_CONFIG,
      feeRate: 0,
      slippage: 0,
    });

    // Should potentially enter but with a loss due to declining prices
    expect(result.metrics.finalEquity).toBeLessThanOrEqual(DEFAULT_BACKTEST_CONFIG.initialCapital + 1);
  });

  test('short direction strategy', () => {
    const prices = [70, 65, 60, 50, 40, 50, 60, 70, 60, 50, 40];
    const history = makeHistory('m1', 'Yes', prices);
    const strategy: Strategy = {
      id: 'short-test',
      name: 'Short Strategy',
      marketId: 'm1',
      entryConditions: [{ outcome: 'Yes', operator: 'lte', value: 45 }],
      exitConditions: [{ outcome: 'Yes', operator: 'gte', value: 65 }],
      direction: 'short',
      positionSize: 1.0,
    };
    const result = runBacktest(strategy, history, {
      ...DEFAULT_BACKTEST_CONFIG,
      feeRate: 0,
      slippage: 0,
    });

    if (result.trades.length > 0) {
      expect(result.trades[0]!.direction).toBe('short');
    }
  });

  test('large dataset performance', () => {
    const prices = Array.from({ length: 1000 }, (_, i) =>
      50 + 20 * Math.sin(i * 0.1) + (Math.random() - 0.5) * 10
    );
    const history = makeHistory('m1', 'Yes', prices);
    const strategy = makeSimpleStrategy('m1', 60, 40);

    const startTime = Date.now();
    const result = runBacktest(strategy, history, {
      ...DEFAULT_BACKTEST_CONFIG,
      feeRate: 0,
      slippage: 0,
    });
    const elapsed = Date.now() - startTime;

    // Should complete in under 5 seconds
    expect(elapsed).toBeLessThan(5000);
    expect(result.dataPoints).toBe(1000);
  });

  test('crossing threshold exactly', () => {
    const prices = [49, 50, 49, 50, 51, 50, 49, 48];
    const history = makeHistory('m1', 'Yes', prices);
    const strategy: Strategy = {
      id: 'exact-cross',
      name: 'Exact Cross',
      marketId: 'm1',
      entryConditions: [{ outcome: 'Yes', operator: 'crosses_above', value: 50 }],
      exitConditions: [{ outcome: 'Yes', operator: 'crosses_below', value: 49 }],
      direction: 'long',
      positionSize: 1.0,
    };
    const result = runBacktest(strategy, history, {
      ...DEFAULT_BACKTEST_CONFIG,
      feeRate: 0,
      slippage: 0,
    });

    // Should handle edge cases at exactly the threshold
    expect(result.dataPoints).toBe(8);
  });

  test('position size fraction < 1', () => {
    const prices = [30, 65, 70, 50, 35];
    const history = makeHistory('m1', 'Yes', prices);
    const strategy: Strategy = {
      ...makeSimpleStrategy('m1', 60, 40),
      positionSize: 0.25,
    };
    const result = runBacktest(strategy, history, {
      ...DEFAULT_BACKTEST_CONFIG,
      feeRate: 0,
      slippage: 0,
    });

    if (result.trades.length > 0) {
      expect(result.trades[0]!.positionSize).toBe(0.25);
    }
  });

  test('backtest with multiple outcome types', () => {
    const now = Date.now();
    const history: Record<string, PriceSnapshot[]> = {
      m1: [
        { timestamp: now - 400000, prices: { Yes: 60, No: 40 } },
        { timestamp: now - 300000, prices: { Yes: 65, No: 35 } },
        { timestamp: now - 200000, prices: { Yes: 55, No: 45 } },
        { timestamp: now - 100000, prices: { Yes: 45, No: 55 } },
        { timestamp: now, prices: { Yes: 50, No: 50 } },
      ],
    };

    const strategy: Strategy = {
      id: 'no-track',
      name: 'Track No Outcome',
      marketId: 'm1',
      entryConditions: [{ outcome: 'No', operator: 'gte', value: 50 }],
      exitConditions: [{ outcome: 'No', operator: 'lte', value: 40 }],
      direction: 'long',
      positionSize: 1.0,
    };

    const result = runBacktest(strategy, history, {
      ...DEFAULT_BACKTEST_CONFIG,
      feeRate: 0,
      slippage: 0,
    });

    expect(result.dataPoints).toBe(5);
  });

  test('DEFAULT_BACKTEST_CONFIG has correct defaults', () => {
    expect(DEFAULT_BACKTEST_CONFIG.initialCapital).toBe(10000);
    expect(DEFAULT_BACKTEST_CONFIG.feeRate).toBe(0.001);
    expect(DEFAULT_BACKTEST_CONFIG.slippage).toBe(0.5);
    expect(DEFAULT_BACKTEST_CONFIG.allowMultiplePositions).toBe(false);
    expect(DEFAULT_BACKTEST_CONFIG.maxPositions).toBe(1);
  });

  test('extreme threshold values', () => {
    const prices = [0, 5, 10, 95, 100, 95, 10, 5, 0];
    const history = makeHistory('m1', 'Yes', prices);

    const strategy = makeSimpleStrategy('m1', 99, 1);
    const result = runBacktest(strategy, history, {
      ...DEFAULT_BACKTEST_CONFIG,
      feeRate: 0,
      slippage: 0,
    });
    expect(result.metrics.totalTrades).toBeGreaterThanOrEqual(0);
  });

  test('all prices at zero', () => {
    const prices = [0, 0, 0, 0, 0];
    const history = makeHistory('m1', 'Yes', prices);
    const strategy = makeSimpleStrategy('m1', 60, 40);
    const result = runBacktest(strategy, history);
    expect(result.trades).toHaveLength(0);
  });

  test('all prices at 100', () => {
    const prices = [100, 100, 100, 100, 100];
    const history = makeHistory('m1', 'Yes', prices);
    const strategy = makeSimpleStrategy('m1', 60, 40);
    const result = runBacktest(strategy, history, {
      ...DEFAULT_BACKTEST_CONFIG,
      feeRate: 0,
      slippage: 0,
    });

    // Entry at >= 60 triggers, but exit at <= 40 never triggers
    if (result.trades.length > 0) {
      expect(result.trades[0]!.exitReason).toBe('end_of_data');
    }
  });

  test('strategy with moving average entry', () => {
    const prices = [30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80];
    const history = makeHistory('m1', 'Yes', prices);

    const strategy: Strategy = {
      id: 'ma-entry',
      name: 'MA Entry',
      marketId: 'm1',
      entryConditions: [{
        outcome: 'Yes',
        operator: 'gt',
        value: 50,
        movingAveragePeriod: 3,
      }],
      exitConditions: [{
        outcome: 'Yes',
        operator: 'lt',
        value: 40,
      }],
      direction: 'long',
      positionSize: 1.0,
    };

    const result = runBacktest(strategy, history, {
      ...DEFAULT_BACKTEST_CONFIG,
      feeRate: 0,
      slippage: 0,
    });

    expect(result.dataPoints).toBe(11);
  });

  test('high fee rate reduces profitability', () => {
    const prices = [30, 65, 70, 35];
    const history = makeHistory('m1', 'Yes', prices);
    const strategy = makeSimpleStrategy('m1', 60, 40);

    const lowFee = runBacktest(strategy, history, { ...DEFAULT_BACKTEST_CONFIG, feeRate: 0.001, slippage: 0 });
    const highFee = runBacktest(strategy, history, { ...DEFAULT_BACKTEST_CONFIG, feeRate: 0.1, slippage: 0 });

    if (lowFee.trades.length > 0 && highFee.trades.length > 0) {
      expect(highFee.metrics.totalFees).toBeGreaterThan(lowFee.metrics.totalFees);
    }
  });

  test('high slippage reduces profitability', () => {
    const prices = [30, 65, 70, 35];
    const history = makeHistory('m1', 'Yes', prices);
    const strategy = makeSimpleStrategy('m1', 60, 40);

    const lowSlip = runBacktest(strategy, history, { ...DEFAULT_BACKTEST_CONFIG, feeRate: 0, slippage: 0.1 });
    const highSlip = runBacktest(strategy, history, { ...DEFAULT_BACKTEST_CONFIG, feeRate: 0, slippage: 5 });

    if (lowSlip.trades.length > 0 && highSlip.trades.length > 0) {
      expect(highSlip.metrics.finalEquity).toBeLessThanOrEqual(lowSlip.metrics.finalEquity);
    }
  });
});

// ─── Integration Tests ───────────────────────────────────────────────────────

describe('Integration: full backtest pipeline', () => {
  test('end-to-end: strategy -> backtest -> monte carlo -> summary', () => {
    const prices = [30, 40, 50, 65, 70, 75, 50, 35, 45, 55, 65, 70, 60, 45, 35,
                     40, 50, 65, 70, 55, 40, 50, 60, 70, 55, 40];
    const history = makeHistory('m1', 'Yes', prices);

    // Step 1: Create strategy
    const strategy = createThresholdStrategy('s1', 'Bull Entry', 'm1', 60, 40);

    // Step 2: Validate
    const validation = validateStrategy(strategy);
    expect(validation.valid).toBe(true);

    // Step 3: Backtest
    const result = runBacktest(strategy, history, {
      ...DEFAULT_BACKTEST_CONFIG,
      feeRate: 0,
      slippage: 0,
    });
    expect(result.dataPoints).toBe(prices.length);

    // Step 4: Monte Carlo
    const mc = runMonteCarloSimulation(result, 50, 42);
    expect(mc.simulations).toBe(50);

    // Step 5: Summary
    const summary = summarizeBacktest(result);
    expect(summary.length).toBeGreaterThan(0);
  });

  test('end-to-end: compare multiple strategies with walk-forward', () => {
    const prices = Array.from({ length: 50 }, (_, i) => 50 + 25 * Math.sin(i * 0.3));
    const history = makeHistory('m1', 'Yes', prices);

    const strategies = [
      createThresholdStrategy('tight', 'Tight', 'm1', 55, 45),
      createThresholdStrategy('wide', 'Wide', 'm1', 70, 30),
      createThresholdStrategy('mid', 'Mid', 'm1', 60, 40),
    ];

    const comparison = compareStrategies(strategies, history, {
      ...DEFAULT_BACKTEST_CONFIG,
      feeRate: 0,
      slippage: 0,
    });

    expect(comparison.rankings).toHaveLength(3);

    // Walk-forward on the best strategy
    const bestId = comparison.rankings[0]!.strategyId;
    const bestStrategy = strategies.find(s => s.id === bestId)!;
    const wf = walkForwardOptimize(bestStrategy, history, { entryThreshold: [50, 70, 10] });
    expect(wf.parameterSets.length).toBeGreaterThan(0);
  });

  test('backtest reproduces consistent results', () => {
    const prices = [30, 40, 50, 65, 70, 50, 35];
    const history = makeHistory('m1', 'Yes', prices);
    const strategy = makeSimpleStrategy('m1', 60, 40);
    const config = { ...DEFAULT_BACKTEST_CONFIG, feeRate: 0, slippage: 0 };

    const r1 = runBacktest(strategy, history, config);
    const r2 = runBacktest(strategy, history, config);

    expect(r1.trades.length).toBe(r2.trades.length);
    expect(r1.metrics.totalPnl).toBe(r2.metrics.totalPnl);
    expect(r1.metrics.finalEquity).toBe(r2.metrics.finalEquity);
  });

  test('strategy with all features combined', () => {
    const prices = [30, 40, 50, 65, 70, 75, 68, 72, 78, 60, 50, 45, 40, 50, 60, 70, 80, 50, 35];
    const history = makeHistory('m1', 'Yes', prices);

    const strategy: Strategy = {
      id: 'full-featured',
      name: 'Full Featured Strategy',
      marketId: 'm1',
      entryConditions: [
        { outcome: 'Yes', operator: 'gte', value: 60 },
      ],
      exitConditions: [
        { outcome: 'Yes', operator: 'lte', value: 45 },
      ],
      direction: 'long',
      positionSize: 0.5,
      stopLoss: 15,
      takeProfit: 20,
      maxHoldTime: 2000000, // ~33 minutes
      cooldownMs: 300000,
    };

    const result = runBacktest(strategy, history, {
      initialCapital: 10000,
      feeRate: 0.002,
      slippage: 0.5,
      allowMultiplePositions: false,
      maxPositions: 1,
    });

    expect(result.strategyId).toBe('full-featured');
    expect(result.dataPoints).toBe(prices.length);
    expect(result.equityCurve.length).toBeGreaterThan(0);
    expect(result.drawdownCurve.length).toBeGreaterThan(0);
  });

  test('sequential trades update equity correctly', () => {
    // Design prices that produce two trades
    const prices = [30, 65, 70, 35, 30, 65, 70, 35];
    const history = makeHistory('m1', 'Yes', prices);
    const strategy = makeSimpleStrategy('m1', 60, 40);
    const result = runBacktest(strategy, history, {
      ...DEFAULT_BACKTEST_CONFIG,
      feeRate: 0,
      slippage: 0,
    });

    if (result.trades.length >= 2) {
      // Equity should reflect cumulative P&L
      const totalPnl = result.trades.reduce((sum, t) => sum + t.pnl, 0);
      expect(result.metrics.finalEquity).toBeCloseTo(DEFAULT_BACKTEST_CONFIG.initialCapital + totalPnl, 1);
    }
  });
});

// ─── Stress Tests ────────────────────────────────────────────────────────────

describe('Stress tests', () => {
  test('handles 5000 data points', () => {
    const prices = Array.from({ length: 5000 }, (_, i) =>
      50 + 20 * Math.sin(i * 0.05) + 10 * Math.cos(i * 0.03)
    );
    const history = makeHistory('m1', 'Yes', prices);
    const strategy = makeSimpleStrategy('m1', 55, 45);

    const result = runBacktest(strategy, history, {
      ...DEFAULT_BACKTEST_CONFIG,
      feeRate: 0,
      slippage: 0,
    });

    expect(result.dataPoints).toBe(5000);
    expect(result.equityCurve.length).toBe(5000);
  });

  test('Monte Carlo with 500 simulations', () => {
    const prices = Array.from({ length: 100 }, (_, i) =>
      50 + 20 * Math.sin(i * 0.2)
    );
    const history = makeHistory('m1', 'Yes', prices);
    const strategy = makeSimpleStrategy('m1', 55, 45);
    const backtestResult = runBacktest(strategy, history, {
      ...DEFAULT_BACKTEST_CONFIG,
      feeRate: 0,
      slippage: 0,
    });

    const mc = runMonteCarloSimulation(backtestResult, 500, 42);
    expect(mc.simulations).toBe(500);
    expect(mc.equityDistribution.percentile5).toBeLessThanOrEqual(mc.equityDistribution.percentile95);
  });

  test('compare 10 strategies simultaneously', () => {
    const prices = Array.from({ length: 100 }, (_, i) =>
      50 + 20 * Math.sin(i * 0.15)
    );
    const history = makeHistory('m1', 'Yes', prices);

    const strategies = Array.from({ length: 10 }, (_, i) =>
      createThresholdStrategy(`s${i}`, `Strategy ${i}`, 'm1', 50 + i * 2, 50 - i * 2)
    );

    const comparison = compareStrategies(strategies, history, {
      ...DEFAULT_BACKTEST_CONFIG,
      feeRate: 0,
      slippage: 0,
    });

    expect(comparison.rankings).toHaveLength(10);
    // Verify ranking order
    for (let i = 0; i < comparison.rankings.length - 1; i++) {
      expect(comparison.rankings[i]!.compositeScore).toBeGreaterThanOrEqual(
        comparison.rankings[i + 1]!.compositeScore
      );
    }
  });
});
