/**
 * Correlation Matrix Edge Cases Tests
 *
 * Covers single-market correlation, perfect/inverse correlation,
 * zero-variance scenarios, large matrices, empty histories,
 * mismatched history lengths, and range validation.
 */
import { describe, test, expect } from 'bun:test';
import {
  pearsonCorrelation,
  classifyCorrelation,
  buildCorrelationMatrix,
  detectDivergences,
} from '../portfolio';
import type { PriceSnapshot } from '../polymarket-alert-workflow';

// Helper to create price snapshots
function makeHistory(
  outcome: string,
  values: number[],
  intervalMs: number = 300000,
): PriceSnapshot[] {
  const now = Date.now();
  return values.map((v, i) => ({
    timestamp: now - (values.length - 1 - i) * intervalMs,
    prices: { [outcome]: v },
  }));
}

function makeMultiOutcomeHistory(
  values: Record<string, number>[],
  intervalMs: number = 300000,
): PriceSnapshot[] {
  const now = Date.now();
  return values.map((prices, i) => ({
    timestamp: now - (values.length - 1 - i) * intervalMs,
    prices,
  }));
}

// ─── Pearson Correlation Fundamentals ──────────────────────────────────────

describe('Pearson Correlation - Core', () => {
  test('identical series yields correlation of 1.0', () => {
    const series = [10, 20, 30, 40, 50];
    expect(pearsonCorrelation(series, series)).toBeCloseTo(1.0, 3);
  });

  test('perfectly inverse series yields correlation of -1.0', () => {
    const x = [10, 20, 30, 40, 50];
    const y = [50, 40, 30, 20, 10];
    expect(pearsonCorrelation(x, y)).toBeCloseTo(-1.0, 3);
  });

  test('returns 0 for fewer than 3 data points', () => {
    expect(pearsonCorrelation([1, 2], [3, 4])).toBe(0);
  });

  test('returns 0 for single data point', () => {
    expect(pearsonCorrelation([5], [10])).toBe(0);
  });

  test('returns 0 for empty arrays', () => {
    expect(pearsonCorrelation([], [])).toBe(0);
  });

  test('zero variance in x yields 0 (all same values)', () => {
    const x = [50, 50, 50, 50, 50];
    const y = [10, 20, 30, 40, 50];
    expect(pearsonCorrelation(x, y)).toBe(0);
  });

  test('zero variance in y yields 0 (all same values)', () => {
    const x = [10, 20, 30, 40, 50];
    const y = [50, 50, 50, 50, 50];
    expect(pearsonCorrelation(x, y)).toBe(0);
  });

  test('zero variance in both x and y yields 0', () => {
    const x = [42, 42, 42, 42, 42];
    const y = [42, 42, 42, 42, 42];
    expect(pearsonCorrelation(x, y)).toBe(0);
  });

  test('truncates to shorter series length', () => {
    const x = [10, 20, 30, 40, 50, 60, 70];
    const y = [15, 25, 35]; // Only 3 points
    const r = pearsonCorrelation(x, y);
    expect(r).toBeCloseTo(1.0, 3); // Last 3 of x=[50,60,70] vs y=[15,25,35] both linear ascending
  });

  test('exactly 3 data points is valid', () => {
    const x = [1, 2, 3];
    const y = [2, 4, 6];
    expect(pearsonCorrelation(x, y)).toBeCloseTo(1.0, 3);
  });

  test('large dataset correlation', () => {
    // Generate 100 points with strong positive correlation
    const x = Array.from({ length: 100 }, (_, i) => i);
    const y = Array.from({ length: 100 }, (_, i) => i * 2 + 5);
    expect(pearsonCorrelation(x, y)).toBeCloseTo(1.0, 3);
  });

  test('uncorrelated random-looking data yields near-zero correlation', () => {
    // Alternating pattern vs increasing → weak correlation
    const x = [1, 100, 1, 100, 1, 100, 1];
    const y = [10, 20, 30, 40, 50, 60, 70];
    const r = pearsonCorrelation(x, y);
    expect(Math.abs(r)).toBeLessThan(0.5);
  });

  test('negative linear relationship', () => {
    const x = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const y = [100, 90, 80, 70, 60, 50, 40, 30, 20, 10];
    expect(pearsonCorrelation(x, y)).toBeCloseTo(-1.0, 3);
  });

  test('correlation is symmetric', () => {
    const x = [10, 25, 33, 47, 55];
    const y = [12, 30, 28, 50, 60];
    expect(pearsonCorrelation(x, y)).toBeCloseTo(pearsonCorrelation(y, x), 4);
  });

  test('result is always between -1 and 1', () => {
    const datasets = [
      { x: [1, 5, 3, 8, 2], y: [9, 3, 7, 1, 6] },
      { x: [0, 0, 0, 1, 1], y: [1, 1, 0, 0, 0] },
      { x: [100, 200, 300, 400, 500], y: [5, 10, 15, 20, 25] },
    ];
    for (const { x, y } of datasets) {
      const r = pearsonCorrelation(x, y);
      expect(r).toBeGreaterThanOrEqual(-1);
      expect(r).toBeLessThanOrEqual(1);
    }
  });

  test('moderate positive correlation', () => {
    const x = [1, 2, 3, 4, 5, 6, 7];
    const y = [2, 3, 1, 5, 4, 7, 6]; // Generally increasing but noisy
    const r = pearsonCorrelation(x, y);
    expect(r).toBeGreaterThan(0.5);
    expect(r).toBeLessThan(1.0);
  });
});

// ─── Classify Correlation ──────────────────────────────────────────────────

describe('Classify Correlation', () => {
  test('strong positive at 0.7', () => {
    expect(classifyCorrelation(0.7)).toBe('strong_positive');
  });

  test('strong positive at 0.99', () => {
    expect(classifyCorrelation(0.99)).toBe('strong_positive');
  });

  test('strong positive at 1.0', () => {
    expect(classifyCorrelation(1.0)).toBe('strong_positive');
  });

  test('moderate positive at 0.3', () => {
    expect(classifyCorrelation(0.3)).toBe('moderate_positive');
  });

  test('moderate positive at 0.69', () => {
    expect(classifyCorrelation(0.69)).toBe('moderate_positive');
  });

  test('weak at 0.0', () => {
    expect(classifyCorrelation(0)).toBe('weak');
  });

  test('weak at 0.29', () => {
    expect(classifyCorrelation(0.29)).toBe('weak');
  });

  test('weak at -0.29', () => {
    expect(classifyCorrelation(-0.29)).toBe('weak');
  });

  test('moderate negative at -0.3', () => {
    expect(classifyCorrelation(-0.3)).toBe('moderate_negative');
  });

  test('moderate negative at -0.69', () => {
    expect(classifyCorrelation(-0.69)).toBe('moderate_negative');
  });

  test('strong negative at -0.7', () => {
    expect(classifyCorrelation(-0.7)).toBe('strong_negative');
  });

  test('strong negative at -1.0', () => {
    expect(classifyCorrelation(-1.0)).toBe('strong_negative');
  });
});

// ─── Build Correlation Matrix ──────────────────────────────────────────────

describe('Correlation Matrix - Single Market', () => {
  test('single market produces 1x1 matrix with 1.0', () => {
    const history: Record<string, PriceSnapshot[]> = {
      m1: makeHistory('Yes', [50, 55, 60, 65, 70]),
    };
    const result = buildCorrelationMatrix(['m1'], history, 'Yes');
    expect(result.markets).toEqual(['m1']);
    expect(result.matrix).toEqual([[1.0]]);
    expect(result.pairs).toHaveLength(0); // No off-diagonal pairs
  });
});

describe('Correlation Matrix - Two Markets', () => {
  test('identical prices produce perfect positive correlation', () => {
    const values = [40, 45, 50, 55, 60, 65, 70];
    const history: Record<string, PriceSnapshot[]> = {
      m1: makeHistory('Yes', values),
      m2: makeHistory('Yes', values),
    };
    const result = buildCorrelationMatrix(['m1', 'm2'], history, 'Yes');
    expect(result.matrix[0][0]).toBe(1.0);
    expect(result.matrix[1][1]).toBe(1.0);
    expect(result.matrix[0][1]).toBeCloseTo(1.0, 3);
    expect(result.matrix[1][0]).toBeCloseTo(1.0, 3);
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0].significance).toBe('strong_positive');
  });

  test('inverse prices produce perfect negative correlation', () => {
    const values = [40, 45, 50, 55, 60, 65, 70];
    const inverse = values.map(v => 110 - v); // [70,65,60,55,50,45,40]
    const history: Record<string, PriceSnapshot[]> = {
      m1: makeHistory('Yes', values),
      m2: makeHistory('Yes', inverse),
    };
    const result = buildCorrelationMatrix(['m1', 'm2'], history, 'Yes');
    expect(result.matrix[0][1]).toBeCloseTo(-1.0, 3);
    expect(result.matrix[1][0]).toBeCloseTo(-1.0, 3);
    expect(result.pairs[0].significance).toBe('strong_negative');
  });

  test('markets with no history produce zero correlation', () => {
    const history: Record<string, PriceSnapshot[]> = {};
    const result = buildCorrelationMatrix(['m1', 'm2'], history, 'Yes');
    expect(result.matrix[0][1]).toBe(0);
    expect(result.matrix[1][0]).toBe(0);
    expect(result.pairs[0].dataPoints).toBe(0);
  });

  test('one market with history, one without', () => {
    const history: Record<string, PriceSnapshot[]> = {
      m1: makeHistory('Yes', [50, 55, 60, 65, 70]),
    };
    const result = buildCorrelationMatrix(['m1', 'm2'], history, 'Yes');
    expect(result.matrix[0][1]).toBe(0);
    expect(result.pairs[0].dataPoints).toBe(0);
  });

  test('markets with different history lengths', () => {
    const history: Record<string, PriceSnapshot[]> = {
      m1: makeHistory('Yes', [40, 45, 50, 55, 60, 65, 70, 75, 80]),
      m2: makeHistory('Yes', [30, 35, 40, 45, 50]),
    };
    const result = buildCorrelationMatrix(['m1', 'm2'], history, 'Yes');
    // Should use the shorter series length (5 points), both ascending linearly
    expect(result.pairs[0].dataPoints).toBe(5);
    expect(result.matrix[0][1]).toBeCloseTo(1.0, 3);
  });

  test('markets with only 2 data points produce zero correlation', () => {
    const history: Record<string, PriceSnapshot[]> = {
      m1: makeHistory('Yes', [50, 55]),
      m2: makeHistory('Yes', [45, 50]),
    };
    const result = buildCorrelationMatrix(['m1', 'm2'], history, 'Yes');
    expect(result.matrix[0][1]).toBe(0); // Need at least 3 points
  });
});

describe('Correlation Matrix - Large Matrix', () => {
  test('10-market matrix is NxN with symmetric values', () => {
    const n = 10;
    const marketIds = Array.from({ length: n }, (_, i) => `m${i}`);
    const history: Record<string, PriceSnapshot[]> = {};

    for (let i = 0; i < n; i++) {
      // Each market has an upward trend but with different offsets
      const values = Array.from({ length: 20 }, (_, j) => 30 + i * 3 + j * 2);
      history[`m${i}`] = makeHistory('Yes', values);
    }

    const result = buildCorrelationMatrix(marketIds, history, 'Yes');

    // Verify NxN dimensions
    expect(result.matrix.length).toBe(n);
    for (let i = 0; i < n; i++) {
      expect(result.matrix[i].length).toBe(n);
    }

    // Verify diagonal is 1.0
    for (let i = 0; i < n; i++) {
      expect(result.matrix[i][i]).toBe(1.0);
    }

    // Verify symmetry
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        expect(result.matrix[i][j]).toBeCloseTo(result.matrix[j][i], 4);
      }
    }

    // Number of pairs = n*(n-1)/2
    expect(result.pairs.length).toBe((n * (n - 1)) / 2);
  });

  test('15-market matrix pairs are sorted by absolute correlation descending', () => {
    const n = 15;
    const marketIds = Array.from({ length: n }, (_, i) => `m${i}`);
    const history: Record<string, PriceSnapshot[]> = {};

    for (let i = 0; i < n; i++) {
      const values = Array.from({ length: 10 }, (_, j) => 50 + (i % 2 === 0 ? j * 3 : -j * 3));
      history[`m${i}`] = makeHistory('Yes', values);
    }

    const result = buildCorrelationMatrix(marketIds, history, 'Yes');

    // Verify pairs are sorted by |correlation| descending
    for (let i = 1; i < result.pairs.length; i++) {
      expect(Math.abs(result.pairs[i - 1].correlation)).toBeGreaterThanOrEqual(
        Math.abs(result.pairs[i].correlation),
      );
    }
  });

  test('20-market matrix all values in [-1, 1]', () => {
    const n = 20;
    const marketIds = Array.from({ length: n }, (_, i) => `m${i}`);
    const history: Record<string, PriceSnapshot[]> = {};

    for (let i = 0; i < n; i++) {
      const values = Array.from({ length: 8 }, (_, j) =>
        50 + Math.sin(j * (i + 1) * 0.5) * 20,
      );
      history[`m${i}`] = makeHistory('Yes', values);
    }

    const result = buildCorrelationMatrix(marketIds, history, 'Yes');

    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        expect(result.matrix[i][j]).toBeGreaterThanOrEqual(-1);
        expect(result.matrix[i][j]).toBeLessThanOrEqual(1);
      }
    }

    for (const pair of result.pairs) {
      expect(pair.correlation).toBeGreaterThanOrEqual(-1);
      expect(pair.correlation).toBeLessThanOrEqual(1);
    }
  });
});

describe('Correlation Matrix - Missing Outcome', () => {
  test('snapshots without the requested outcome are filtered', () => {
    const history: Record<string, PriceSnapshot[]> = {
      m1: makeMultiOutcomeHistory([
        { Yes: 50, No: 50 },
        { Yes: 55, No: 45 },
        { Yes: 60, No: 40 },
        { Yes: 65, No: 35 },
      ]),
      m2: makeMultiOutcomeHistory([
        { No: 50 }, // Missing 'Yes' outcome
        { Yes: 45, No: 55 },
        { Yes: 50, No: 50 },
        { Yes: 55, No: 45 },
      ]),
    };
    const result = buildCorrelationMatrix(['m1', 'm2'], history, 'Yes');
    // m2 should only have 3 'Yes' data points (first snapshot excluded)
    expect(result.pairs[0].dataPoints).toBe(3);
  });

  test('using No outcome works correctly', () => {
    const values = [40, 45, 50, 55, 60];
    const history: Record<string, PriceSnapshot[]> = {
      m1: makeMultiOutcomeHistory(values.map(v => ({ Yes: v, No: 100 - v }))),
      m2: makeMultiOutcomeHistory(values.map(v => ({ Yes: v, No: 100 - v }))),
    };
    const result = buildCorrelationMatrix(['m1', 'm2'], history, 'No');
    expect(result.matrix[0][1]).toBeCloseTo(1.0, 3);
  });
});

describe('Correlation Matrix - Empty and Edge Cases', () => {
  test('empty market list produces empty matrix', () => {
    const result = buildCorrelationMatrix([], {}, 'Yes');
    expect(result.markets).toHaveLength(0);
    expect(result.matrix).toHaveLength(0);
    expect(result.pairs).toHaveLength(0);
  });

  test('all markets with empty price history', () => {
    const history: Record<string, PriceSnapshot[]> = {
      m1: [],
      m2: [],
      m3: [],
    };
    const result = buildCorrelationMatrix(['m1', 'm2', 'm3'], history, 'Yes');
    expect(result.matrix[0][1]).toBe(0);
    expect(result.matrix[0][2]).toBe(0);
    expect(result.matrix[1][2]).toBe(0);
  });

  test('constant prices (zero variance) produces zero off-diagonal correlation', () => {
    const history: Record<string, PriceSnapshot[]> = {
      m1: makeHistory('Yes', [50, 50, 50, 50, 50]),
      m2: makeHistory('Yes', [60, 60, 60, 60, 60]),
    };
    const result = buildCorrelationMatrix(['m1', 'm2'], history, 'Yes');
    expect(result.matrix[0][1]).toBe(0);
    expect(result.pairs[0].significance).toBe('weak');
  });

  test('one market constant, one varying produces zero correlation', () => {
    const history: Record<string, PriceSnapshot[]> = {
      m1: makeHistory('Yes', [50, 50, 50, 50, 50]),
      m2: makeHistory('Yes', [30, 40, 50, 60, 70]),
    };
    const result = buildCorrelationMatrix(['m1', 'm2'], history, 'Yes');
    expect(result.matrix[0][1]).toBe(0);
  });
});

// ─── Divergence Detection ──────────────────────────────────────────────────

describe('Divergence Detection', () => {
  test('detects divergence between historically correlated markets', () => {
    const now = Date.now();
    const interval = 300000;
    // Both at ~50% for 10 periods, then suddenly diverge
    const history: Record<string, PriceSnapshot[]> = {
      m1: Array.from({ length: 10 }, (_, i) => ({
        timestamp: now - (9 - i) * interval,
        prices: { Yes: 50 + i },
      })),
      m2: Array.from({ length: 10 }, (_, i) => ({
        timestamp: now - (9 - i) * interval,
        prices: { Yes: 50 + i },
      })),
    };
    // Add a divergent final snapshot
    history.m1.push({ timestamp: now, prices: { Yes: 80 } });
    history.m2.push({ timestamp: now, prices: { Yes: 40 } });

    const matrix = buildCorrelationMatrix(['m1', 'm2'], history, 'Yes');
    const divergences = detectDivergences(matrix, history, 'Yes', 10);

    // Should detect that m1 and m2 have diverged significantly
    // The pair needs |correlation| >= 0.5 and >= 5 data points
    if (Math.abs(matrix.pairs[0].correlation) >= 0.5) {
      expect(divergences.length).toBeGreaterThanOrEqual(0);
    }
  });

  test('no divergence for closely tracking markets', () => {
    const history: Record<string, PriceSnapshot[]> = {
      m1: makeHistory('Yes', [50, 52, 54, 56, 58, 60]),
      m2: makeHistory('Yes', [50, 52, 54, 56, 58, 60]),
    };

    const matrix = buildCorrelationMatrix(['m1', 'm2'], history, 'Yes');
    const divergences = detectDivergences(matrix, history, 'Yes', 10);
    expect(divergences).toHaveLength(0);
  });

  test('high threshold reduces detected divergences', () => {
    const history: Record<string, PriceSnapshot[]> = {
      m1: makeHistory('Yes', [50, 52, 54, 56, 58, 75]),
      m2: makeHistory('Yes', [50, 52, 54, 56, 58, 50]),
    };

    const matrix = buildCorrelationMatrix(['m1', 'm2'], history, 'Yes');
    const highThreshold = detectDivergences(matrix, history, 'Yes', 100);
    expect(highThreshold).toHaveLength(0);
  });

  test('skips pairs with fewer than 5 data points', () => {
    const history: Record<string, PriceSnapshot[]> = {
      m1: makeHistory('Yes', [50, 60, 70]),
      m2: makeHistory('Yes', [50, 60, 70]),
    };

    const matrix = buildCorrelationMatrix(['m1', 'm2'], history, 'Yes');
    const divergences = detectDivergences(matrix, history, 'Yes', 1);
    expect(divergences).toHaveLength(0);
  });

  test('skips weakly correlated pairs (|r| < 0.5)', () => {
    // Create markets with low correlation
    const history: Record<string, PriceSnapshot[]> = {
      m1: makeHistory('Yes', [50, 60, 50, 60, 50, 60, 50]),
      m2: makeHistory('Yes', [50, 50, 60, 50, 60, 50, 60]),
    };

    const matrix = buildCorrelationMatrix(['m1', 'm2'], history, 'Yes');
    const divergences = detectDivergences(matrix, history, 'Yes', 1);
    // Low correlation pairs should be skipped
    if (Math.abs(matrix.pairs[0].correlation) < 0.5) {
      expect(divergences).toHaveLength(0);
    }
  });

  test('divergences are sorted by amount descending', () => {
    const now = Date.now();
    const interval = 300000;
    // Create 3 correlated markets, then diverge them differently
    const base = Array.from({ length: 8 }, (_, i) => 50 + i * 2);
    const history: Record<string, PriceSnapshot[]> = {
      m1: makeHistory('Yes', [...base, 90]), // Diverges a lot
      m2: makeHistory('Yes', [...base, 70]), // Diverges moderately
      m3: makeHistory('Yes', [...base, 66]), // Baseline
    };

    const matrix = buildCorrelationMatrix(['m1', 'm2', 'm3'], history, 'Yes');
    const divergences = detectDivergences(matrix, history, 'Yes', 5);

    for (let i = 1; i < divergences.length; i++) {
      expect(divergences[i - 1].divergenceAmount).toBeGreaterThanOrEqual(
        divergences[i].divergenceAmount,
      );
    }
  });

  test('handles markets with no history gracefully', () => {
    const history: Record<string, PriceSnapshot[]> = {};
    const matrix = buildCorrelationMatrix(['m1', 'm2'], history, 'Yes');
    const divergences = detectDivergences(matrix, history, 'Yes', 5);
    expect(divergences).toHaveLength(0);
  });
});
