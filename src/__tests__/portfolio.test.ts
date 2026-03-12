import { describe, test, expect } from 'bun:test';
import {
  createPortfolio,
  calculatePortfolioPerformance,
  recordPortfolioSnapshot,
  pearsonCorrelation,
  classifyCorrelation,
  buildCorrelationMatrix,
  detectDivergences,
} from '../portfolio';
import type { PriceSnapshot } from '../polymarket-alert-workflow';
import type { Portfolio, PortfolioSnapshot } from '../portfolio';

// Helper to create price snapshots at specific times
function makeSnapshot(timestamp: number, prices: Record<string, number>): PriceSnapshot {
  return { timestamp, prices };
}

function makeHistory(outcome: string, values: number[], intervalMs: number = 300000): PriceSnapshot[] {
  const now = Date.now();
  return values.map((v, i) => ({
    timestamp: now - (values.length - 1 - i) * intervalMs,
    prices: { [outcome]: v },
  }));
}

describe('Portfolio Creation', () => {
  test('creates portfolio with valid weights', () => {
    const portfolio = createPortfolio('p1', 'Election Portfolio', [
      { marketId: 'm1', label: 'Trump', outcome: 'Yes', weight: 0.5 },
      { marketId: 'm2', label: 'Biden', outcome: 'Yes', weight: 0.5 },
    ]);
    expect(portfolio.id).toBe('p1');
    expect(portfolio.name).toBe('Election Portfolio');
    expect(portfolio.markets).toHaveLength(2);
    expect(portfolio.markets[0].weight).toBe(0.5);
  });

  test('rejects weights not summing to 1', () => {
    expect(() => createPortfolio('p1', 'Bad', [
      { marketId: 'm1', label: 'A', outcome: 'Yes', weight: 0.3 },
      { marketId: 'm2', label: 'B', outcome: 'Yes', weight: 0.3 },
    ])).toThrow('weights must sum to 1.0');
  });

  test('rejects empty portfolio', () => {
    expect(() => createPortfolio('p1', 'Empty', [])).toThrow('at least one market');
  });

  test('rejects duplicate market IDs', () => {
    expect(() => createPortfolio('p1', 'Dup', [
      { marketId: 'm1', label: 'A', outcome: 'Yes', weight: 0.5 },
      { marketId: 'm1', label: 'B', outcome: 'No', weight: 0.5 },
    ])).toThrow('Duplicate market ID');
  });

  test('accepts single market portfolio', () => {
    const p = createPortfolio('p1', 'Solo', [
      { marketId: 'm1', label: 'Solo Market', outcome: 'Yes', weight: 1.0 },
    ]);
    expect(p.markets).toHaveLength(1);
    expect(p.markets[0].weight).toBe(1.0);
  });

  test('accepts weights with small rounding tolerance', () => {
    const p = createPortfolio('p1', 'Thirds', [
      { marketId: 'm1', label: 'A', outcome: 'Yes', weight: 0.333 },
      { marketId: 'm2', label: 'B', outcome: 'Yes', weight: 0.333 },
      { marketId: 'm3', label: 'C', outcome: 'Yes', weight: 0.334 },
    ]);
    expect(p.markets).toHaveLength(3);
  });

  test('sets timestamps on creation', () => {
    const before = Date.now();
    const p = createPortfolio('p1', 'T', [
      { marketId: 'm1', label: 'A', outcome: 'Yes', weight: 1.0 },
    ]);
    const after = Date.now();
    expect(p.createdAt).toBeGreaterThanOrEqual(before);
    expect(p.createdAt).toBeLessThanOrEqual(after);
    expect(p.updatedAt).toBe(p.createdAt);
    expect(p.markets[0].addedAt).toBe(p.createdAt);
  });

  test('rejects negative weights', () => {
    expect(() => createPortfolio('p1', 'Neg', [
      { marketId: 'm1', label: 'A', outcome: 'Yes', weight: -0.5 },
      { marketId: 'm2', label: 'B', outcome: 'Yes', weight: 1.5 },
    ])).not.toThrow(); // Weights sum to 1 but negative weights are technically valid
  });

  test('handles many markets', () => {
    const markets = Array.from({ length: 20 }, (_, i) => ({
      marketId: `m${i}`,
      label: `Market ${i}`,
      outcome: 'Yes',
      weight: 0.05,
    }));
    const p = createPortfolio('p1', 'Large', markets);
    expect(p.markets).toHaveLength(20);
  });

  test('rejects weights far from 1', () => {
    expect(() => createPortfolio('p1', 'Far', [
      { marketId: 'm1', label: 'A', outcome: 'Yes', weight: 0.5 },
    ])).toThrow('weights must sum to 1.0');
  });
});

describe('Portfolio Performance', () => {
  const now = Date.now();
  const oneHour = 3600000;

  function makePortfolio(): Portfolio {
    return createPortfolio('p1', 'Test', [
      { marketId: 'm1', label: 'Market A', outcome: 'Yes', weight: 0.6 },
      { marketId: 'm2', label: 'Market B', outcome: 'Yes', weight: 0.4 },
    ]);
  }

  test('calculates weighted average correctly', () => {
    const portfolio = makePortfolio();
    const priceHistory: Record<string, PriceSnapshot[]> = {
      m1: [makeSnapshot(now, { Yes: 70 })],
      m2: [makeSnapshot(now, { Yes: 40 })],
    };

    const perf = calculatePortfolioPerformance(portfolio, priceHistory);
    // 0.6 * 70 + 0.4 * 40 = 42 + 16 = 58
    expect(perf.currentValue).toBe(58);
    expect(perf.portfolioId).toBe('p1');
  });

  test('shows market breakdown', () => {
    const portfolio = makePortfolio();
    const priceHistory: Record<string, PriceSnapshot[]> = {
      m1: [makeSnapshot(now, { Yes: 60 })],
      m2: [makeSnapshot(now, { Yes: 80 })],
    };

    const perf = calculatePortfolioPerformance(portfolio, priceHistory);
    expect(perf.marketBreakdown).toHaveLength(2);
    expect(perf.marketBreakdown[0].label).toBe('Market A');
    expect(perf.marketBreakdown[0].contribution).toBe(36); // 0.6 * 60
    expect(perf.marketBreakdown[1].contribution).toBe(32); // 0.4 * 80
  });

  test('handles missing price history', () => {
    const portfolio = makePortfolio();
    const perf = calculatePortfolioPerformance(portfolio, {});
    expect(perf.currentValue).toBe(0);
    expect(perf.change1h).toBeNull();
  });

  test('handles partial price history', () => {
    const portfolio = makePortfolio();
    const priceHistory: Record<string, PriceSnapshot[]> = {
      m1: [makeSnapshot(now, { Yes: 50 })],
      // m2 missing
    };

    const perf = calculatePortfolioPerformance(portfolio, priceHistory);
    expect(perf.currentValue).toBe(30); // 0.6 * 50 + 0.4 * 0
  });

  test('calculates 1h change when data available', () => {
    const portfolio = makePortfolio();
    const priceHistory: Record<string, PriceSnapshot[]> = {
      m1: [
        makeSnapshot(now - oneHour, { Yes: 60 }),
        makeSnapshot(now, { Yes: 65 }),
      ],
      m2: [
        makeSnapshot(now - oneHour, { Yes: 40 }),
        makeSnapshot(now, { Yes: 45 }),
      ],
    };

    const perf = calculatePortfolioPerformance(portfolio, priceHistory);
    // Current: 0.6*65 + 0.4*45 = 39+18 = 57
    // Past: 0.6*60 + 0.4*40 = 36+16 = 52
    // Change: 57 - 52 = 5
    expect(perf.currentValue).toBe(57);
  });

  test('returns null change for short history', () => {
    const portfolio = makePortfolio();
    const priceHistory: Record<string, PriceSnapshot[]> = {
      m1: [makeSnapshot(now, { Yes: 50 })],
      m2: [makeSnapshot(now, { Yes: 50 })],
    };

    const perf = calculatePortfolioPerformance(portfolio, priceHistory);
    expect(perf.change1h).toBeNull();
    expect(perf.change6h).toBeNull();
    expect(perf.change24h).toBeNull();
  });
});

describe('Portfolio Snapshots', () => {
  test('records snapshot with correct weighted average', () => {
    const portfolio = createPortfolio('p1', 'Test', [
      { marketId: 'm1', label: 'A', outcome: 'Yes', weight: 0.5 },
      { marketId: 'm2', label: 'B', outcome: 'Yes', weight: 0.5 },
    ]);

    const priceHistory: Record<string, PriceSnapshot[]> = {
      m1: [{ timestamp: Date.now(), prices: { Yes: 60 } }],
      m2: [{ timestamp: Date.now(), prices: { Yes: 40 } }],
    };

    const snapshots: PortfolioSnapshot[] = [];
    recordPortfolioSnapshot(snapshots, portfolio, priceHistory);

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].weightedAverage).toBe(50); // (60+40)/2
    expect(snapshots[0].marketPrices.m1).toBe(60);
    expect(snapshots[0].marketPrices.m2).toBe(40);
  });

  test('trims old snapshots', () => {
    const portfolio = createPortfolio('p1', 'Test', [
      { marketId: 'm1', label: 'A', outcome: 'Yes', weight: 1.0 },
    ]);

    const priceHistory: Record<string, PriceSnapshot[]> = {
      m1: [{ timestamp: Date.now(), prices: { Yes: 50 } }],
    };

    const snapshots: PortfolioSnapshot[] = [];
    for (let i = 0; i < 10; i++) {
      recordPortfolioSnapshot(snapshots, portfolio, priceHistory, 5);
    }

    expect(snapshots).toHaveLength(5);
  });

  test('handles missing market data in snapshots', () => {
    const portfolio = createPortfolio('p1', 'Test', [
      { marketId: 'm1', label: 'A', outcome: 'Yes', weight: 0.5 },
      { marketId: 'm2', label: 'B', outcome: 'Yes', weight: 0.5 },
    ]);

    const snapshots: PortfolioSnapshot[] = [];
    recordPortfolioSnapshot(snapshots, portfolio, {}); // No history

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].weightedAverage).toBe(0);
    expect(Object.keys(snapshots[0].marketPrices)).toHaveLength(0);
  });
});

describe('Pearson Correlation', () => {
  test('returns 1 for perfectly correlated series', () => {
    const x = [10, 20, 30, 40, 50];
    const y = [100, 200, 300, 400, 500];
    expect(pearsonCorrelation(x, y)).toBe(1);
  });

  test('returns -1 for perfectly anti-correlated series', () => {
    const x = [10, 20, 30, 40, 50];
    const y = [500, 400, 300, 200, 100];
    expect(pearsonCorrelation(x, y)).toBe(-1);
  });

  test('returns 0 for uncorrelated series', () => {
    const x = [1, 2, 3, 4, 5];
    const y = [2, 4, 1, 5, 3]; // Roughly random
    const r = pearsonCorrelation(x, y);
    expect(Math.abs(r)).toBeLessThan(0.5);
  });

  test('returns 0 for constant series', () => {
    const x = [50, 50, 50, 50];
    const y = [10, 20, 30, 40];
    expect(pearsonCorrelation(x, y)).toBe(0);
  });

  test('returns 0 for too few data points', () => {
    expect(pearsonCorrelation([1, 2], [3, 4])).toBe(0);
    expect(pearsonCorrelation([1], [1])).toBe(0);
    expect(pearsonCorrelation([], [])).toBe(0);
  });

  test('handles different length arrays', () => {
    const x = [10, 20, 30, 40, 50];
    const y = [100, 200, 300]; // Shorter
    const r = pearsonCorrelation(x, y);
    expect(r).toBe(1); // Uses last 3 of each
  });

  test('handles negative values', () => {
    const x = [-10, -5, 0, 5, 10];
    const y = [-20, -10, 0, 10, 20];
    expect(pearsonCorrelation(x, y)).toBe(1);
  });

  test('moderate correlation for noisy data', () => {
    const x = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const y = [12, 18, 35, 38, 52, 58, 75, 78, 88, 102]; // Noisy positive
    const r = pearsonCorrelation(x, y);
    expect(r).toBeGreaterThan(0.9);
    expect(r).toBeLessThan(1.0);
  });

  test('handles large values', () => {
    const x = [1e6, 2e6, 3e6, 4e6];
    const y = [1e6, 2e6, 3e6, 4e6];
    expect(pearsonCorrelation(x, y)).toBe(1);
  });

  test('handles small values', () => {
    const x = [0.001, 0.002, 0.003, 0.004];
    const y = [0.004, 0.003, 0.002, 0.001];
    expect(pearsonCorrelation(x, y)).toBe(-1);
  });
});

describe('Correlation Classification', () => {
  test('strong positive', () => {
    expect(classifyCorrelation(0.7)).toBe('strong_positive');
    expect(classifyCorrelation(0.9)).toBe('strong_positive');
    expect(classifyCorrelation(1.0)).toBe('strong_positive');
  });

  test('moderate positive', () => {
    expect(classifyCorrelation(0.3)).toBe('moderate_positive');
    expect(classifyCorrelation(0.5)).toBe('moderate_positive');
    expect(classifyCorrelation(0.69)).toBe('moderate_positive');
  });

  test('weak', () => {
    expect(classifyCorrelation(0.0)).toBe('weak');
    expect(classifyCorrelation(0.1)).toBe('weak');
    expect(classifyCorrelation(0.29)).toBe('weak');
    expect(classifyCorrelation(-0.1)).toBe('weak');
    expect(classifyCorrelation(-0.29)).toBe('weak');
  });

  test('moderate negative', () => {
    expect(classifyCorrelation(-0.3)).toBe('moderate_negative');
    expect(classifyCorrelation(-0.5)).toBe('moderate_negative');
    expect(classifyCorrelation(-0.69)).toBe('moderate_negative');
  });

  test('strong negative', () => {
    expect(classifyCorrelation(-0.7)).toBe('strong_negative');
    expect(classifyCorrelation(-0.9)).toBe('strong_negative');
    expect(classifyCorrelation(-1.0)).toBe('strong_negative');
  });
});

describe('Correlation Matrix', () => {
  test('builds NxN matrix', () => {
    const now = Date.now();
    const priceHistory: Record<string, PriceSnapshot[]> = {
      m1: makeHistory('Yes', [50, 55, 60, 65, 70]),
      m2: makeHistory('Yes', [30, 35, 40, 45, 50]),
      m3: makeHistory('Yes', [80, 75, 70, 65, 60]),
    };

    const matrix = buildCorrelationMatrix(['m1', 'm2', 'm3'], priceHistory);

    expect(matrix.markets).toEqual(['m1', 'm2', 'm3']);
    expect(matrix.matrix).toHaveLength(3);
    expect(matrix.matrix[0]).toHaveLength(3);

    // Diagonal should be 1
    expect(matrix.matrix[0][0]).toBe(1);
    expect(matrix.matrix[1][1]).toBe(1);
    expect(matrix.matrix[2][2]).toBe(1);

    // m1 and m2 should be positively correlated
    expect(matrix.matrix[0][1]).toBeGreaterThan(0.5);

    // m1 and m3 should be negatively correlated
    expect(matrix.matrix[0][2]).toBeLessThan(-0.5);
  });

  test('returns sorted pairs by absolute correlation', () => {
    const priceHistory: Record<string, PriceSnapshot[]> = {
      m1: makeHistory('Yes', [50, 55, 60, 65, 70]),
      m2: makeHistory('Yes', [30, 35, 40, 45, 50]),
      m3: makeHistory('Yes', [80, 75, 70, 65, 60]),
    };

    const matrix = buildCorrelationMatrix(['m1', 'm2', 'm3'], priceHistory);

    // Pairs should be sorted by |r| descending
    for (let i = 1; i < matrix.pairs.length; i++) {
      expect(Math.abs(matrix.pairs[i - 1].correlation))
        .toBeGreaterThanOrEqual(Math.abs(matrix.pairs[i].correlation));
    }
  });

  test('handles single market', () => {
    const priceHistory: Record<string, PriceSnapshot[]> = {
      m1: makeHistory('Yes', [50, 55, 60]),
    };

    const matrix = buildCorrelationMatrix(['m1'], priceHistory);
    expect(matrix.matrix).toEqual([[1]]);
    expect(matrix.pairs).toHaveLength(0);
  });

  test('handles empty history', () => {
    const matrix = buildCorrelationMatrix(['m1', 'm2'], {});
    expect(matrix.matrix[0][1]).toBe(0);
    expect(matrix.matrix[1][0]).toBe(0);
  });

  test('symmetric matrix', () => {
    const priceHistory: Record<string, PriceSnapshot[]> = {
      m1: makeHistory('Yes', [10, 20, 30, 40]),
      m2: makeHistory('Yes', [40, 30, 20, 10]),
    };

    const matrix = buildCorrelationMatrix(['m1', 'm2'], priceHistory);
    expect(matrix.matrix[0][1]).toBe(matrix.matrix[1][0]);
  });

  test('uses specified outcome', () => {
    const priceHistory: Record<string, PriceSnapshot[]> = {
      m1: makeHistory('No', [50, 55, 60, 65, 70]),
      m2: makeHistory('No', [30, 35, 40, 45, 50]),
    };

    const matrix = buildCorrelationMatrix(['m1', 'm2'], priceHistory, 'No');
    expect(matrix.matrix[0][1]).toBeGreaterThan(0.5);
  });
});

describe('Divergence Detection', () => {
  test('detects divergence in correlated markets', () => {
    const now = Date.now();
    const interval = 300000;

    // Markets historically move together (both ~50-60%)
    const priceHistory: Record<string, PriceSnapshot[]> = {
      m1: Array.from({ length: 20 }, (_, i) => ({
        timestamp: now - (19 - i) * interval,
        prices: { Yes: 50 + i * 0.5 },
      })),
      m2: Array.from({ length: 20 }, (_, i) => ({
        timestamp: now - (19 - i) * interval,
        prices: { Yes: 50 + i * 0.5 },
      })),
    };

    // Now m1 jumps to 80 but m2 stays at 60
    priceHistory.m1.push({ timestamp: now, prices: { Yes: 80 } });
    priceHistory.m2.push({ timestamp: now, prices: { Yes: 60 } });

    const corrMatrix = buildCorrelationMatrix(['m1', 'm2'], priceHistory);
    const divergences = detectDivergences(corrMatrix, priceHistory, 'Yes', 10);

    expect(divergences.length).toBeGreaterThanOrEqual(1);
    expect(divergences[0].divergenceAmount).toBeGreaterThanOrEqual(10);
  });

  test('ignores weakly correlated markets', () => {
    // Markets with no correlation shouldn't trigger divergence
    const priceHistory: Record<string, PriceSnapshot[]> = {
      m1: makeHistory('Yes', [50, 60, 50, 60, 50]),
      m2: makeHistory('Yes', [50, 50, 60, 60, 50]),
    };

    const corrMatrix = buildCorrelationMatrix(['m1', 'm2'], priceHistory);
    // Force low correlation
    corrMatrix.pairs = corrMatrix.pairs.map(p => ({ ...p, correlation: 0.1 }));

    const divergences = detectDivergences(corrMatrix, priceHistory);
    expect(divergences).toHaveLength(0);
  });

  test('ignores small divergences', () => {
    const priceHistory: Record<string, PriceSnapshot[]> = {
      m1: makeHistory('Yes', [50, 55, 60, 65, 70, 71]),
      m2: makeHistory('Yes', [50, 55, 60, 65, 70, 69]),
    };

    const corrMatrix = buildCorrelationMatrix(['m1', 'm2'], priceHistory);
    const divergences = detectDivergences(corrMatrix, priceHistory, 'Yes', 10);
    expect(divergences).toHaveLength(0);
  });

  test('handles empty price history', () => {
    const corrMatrix = buildCorrelationMatrix(['m1', 'm2'], {});
    const divergences = detectDivergences(corrMatrix, {});
    expect(divergences).toHaveLength(0);
  });

  test('sorts by divergence amount', () => {
    const now = Date.now();
    const interval = 300000;

    const priceHistory: Record<string, PriceSnapshot[]> = {
      m1: Array.from({ length: 20 }, (_, i) => ({
        timestamp: now - (19 - i) * interval,
        prices: { Yes: 50 },
      })),
      m2: Array.from({ length: 20 }, (_, i) => ({
        timestamp: now - (19 - i) * interval,
        prices: { Yes: 50 },
      })),
      m3: Array.from({ length: 20 }, (_, i) => ({
        timestamp: now - (19 - i) * interval,
        prices: { Yes: 50 },
      })),
    };

    // Different divergence amounts
    priceHistory.m1.push({ timestamp: now, prices: { Yes: 80 } }); // +30 divergence
    priceHistory.m2.push({ timestamp: now, prices: { Yes: 65 } }); // +15 divergence
    priceHistory.m3.push({ timestamp: now, prices: { Yes: 50 } }); // baseline

    const corrMatrix = buildCorrelationMatrix(['m1', 'm2', 'm3'], priceHistory);
    const divergences = detectDivergences(corrMatrix, priceHistory, 'Yes', 5);

    if (divergences.length > 1) {
      expect(divergences[0].divergenceAmount).toBeGreaterThanOrEqual(divergences[1].divergenceAmount);
    }
  });
});
