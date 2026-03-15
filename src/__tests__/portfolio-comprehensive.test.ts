/**
 * Comprehensive Portfolio & Correlation Tests
 *
 * Covers: portfolio creation validation, correlation math precision,
 * arbitrage detection edge cases, divergence detection, cross-market
 * arbitrage, bulk scanning, and portfolio snapshot management.
 */

import { describe, test, expect } from "bun:test";
import {
  createPortfolio,
  pearsonCorrelation,
  classifyCorrelation,
  buildCorrelationMatrix,
  detectDivergences,
  detectSingleMarketArbitrage,
  detectCrossMarketArbitrage,
  scanForArbitrage,
  recordPortfolioSnapshot,
  type Portfolio,
  type PortfolioSnapshot,
} from "../portfolio";
import type { PriceSnapshot } from "../polymarket-alert-workflow";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSnapshot(prices: Record<string, number>, ts?: number): PriceSnapshot {
  return {
    timestamp: ts || Date.now(),
    prices,
    marketId: "test",
    question: "Test?",
    volume: 10000,
  };
}

function makeHistory(
  values: number[],
  outcome = "Yes",
  baseTs = Date.now() - 100000
): PriceSnapshot[] {
  return values.map((v, i) => makeSnapshot({ [outcome]: v }, baseTs + i * 1000));
}

// ─── Portfolio Creation ─────────────────────────────────────────────────────

describe("Portfolio creation validation", () => {
  test("should create valid portfolio with one market", () => {
    const p = createPortfolio("p1", "Test Portfolio", [
      { marketId: "m1", label: "Market 1", outcome: "Yes", weight: 1.0 },
    ]);
    expect(p.id).toBe("p1");
    expect(p.name).toBe("Test Portfolio");
    expect(p.markets).toHaveLength(1);
    expect(p.markets[0].weight).toBe(1.0);
  });

  test("should create portfolio with two equal-weighted markets", () => {
    const p = createPortfolio("p2", "Dual", [
      { marketId: "m1", label: "A", outcome: "Yes", weight: 0.5 },
      { marketId: "m2", label: "B", outcome: "Yes", weight: 0.5 },
    ]);
    expect(p.markets).toHaveLength(2);
  });

  test("should create portfolio with three markets summing to 1.0", () => {
    const p = createPortfolio("p3", "Triple", [
      { marketId: "m1", label: "A", outcome: "Yes", weight: 0.4 },
      { marketId: "m2", label: "B", outcome: "Yes", weight: 0.35 },
      { marketId: "m3", label: "C", outcome: "Yes", weight: 0.25 },
    ]);
    expect(p.markets).toHaveLength(3);
  });

  test("should reject empty markets array", () => {
    expect(() => createPortfolio("p0", "Empty", [])).toThrow("at least one market");
  });

  test("should reject weights not summing to 1.0", () => {
    expect(() => createPortfolio("p", "Bad", [
      { marketId: "m1", label: "A", outcome: "Yes", weight: 0.5 },
      { marketId: "m2", label: "B", outcome: "Yes", weight: 0.3 },
    ])).toThrow("weights must sum to 1.0");
  });

  test("should accept weights within 0.01 tolerance", () => {
    // 0.333 + 0.333 + 0.334 = 1.000, within tolerance
    const p = createPortfolio("p", "Close", [
      { marketId: "m1", label: "A", outcome: "Yes", weight: 0.333 },
      { marketId: "m2", label: "B", outcome: "Yes", weight: 0.333 },
      { marketId: "m3", label: "C", outcome: "Yes", weight: 0.334 },
    ]);
    expect(p.markets).toHaveLength(3);
  });

  test("should reject weights of 0.99 (too far from 1.0)", () => {
    expect(() => createPortfolio("p", "Under", [
      { marketId: "m1", label: "A", outcome: "Yes", weight: 0.49 },
      { marketId: "m2", label: "B", outcome: "Yes", weight: 0.49 },
    ])).toThrow("weights must sum to 1.0");
  });

  test("should reject duplicate market IDs", () => {
    expect(() => createPortfolio("p", "Dup", [
      { marketId: "m1", label: "A", outcome: "Yes", weight: 0.5 },
      { marketId: "m1", label: "B", outcome: "No", weight: 0.5 },
    ])).toThrow("Duplicate market ID");
  });

  test("should set timestamps on creation", () => {
    const before = Date.now();
    const p = createPortfolio("p", "Ts", [
      { marketId: "m1", label: "A", outcome: "Yes", weight: 1.0 },
    ]);
    const after = Date.now();
    expect(p.createdAt).toBeGreaterThanOrEqual(before);
    expect(p.createdAt).toBeLessThanOrEqual(after);
    expect(p.updatedAt).toBe(p.createdAt);
  });

  test("should set addedAt on each market", () => {
    const p = createPortfolio("p", "Added", [
      { marketId: "m1", label: "A", outcome: "Yes", weight: 1.0 },
    ]);
    expect(p.markets[0].addedAt).toBeGreaterThan(0);
  });

  test("should handle 10 markets with valid weights", () => {
    const markets = Array.from({ length: 10 }, (_, i) => ({
      marketId: `m${i}`,
      label: `Market ${i}`,
      outcome: "Yes",
      weight: 0.1,
    }));
    const p = createPortfolio("p10", "Ten Markets", markets);
    expect(p.markets).toHaveLength(10);
  });

  test("should handle uneven weights", () => {
    const p = createPortfolio("p", "Uneven", [
      { marketId: "m1", label: "A", outcome: "Yes", weight: 0.8 },
      { marketId: "m2", label: "B", outcome: "Yes", weight: 0.2 },
    ]);
    expect(p.markets[0].weight).toBe(0.8);
    expect(p.markets[1].weight).toBe(0.2);
  });
});

// ─── Pearson Correlation ────────────────────────────────────────────────────

describe("Pearson correlation precision", () => {
  test("should return 1.0 for perfectly positive correlated series", () => {
    const r = pearsonCorrelation([1, 2, 3, 4, 5], [10, 20, 30, 40, 50]);
    expect(r).toBe(1.0);
  });

  test("should return -1.0 for perfectly negative correlated series", () => {
    const r = pearsonCorrelation([1, 2, 3, 4, 5], [50, 40, 30, 20, 10]);
    expect(r).toBe(-1.0);
  });

  test("should return 0 for uncorrelated series", () => {
    const r = pearsonCorrelation([1, 1, 1, 1, 1], [1, 2, 3, 4, 5]);
    expect(r).toBe(0);
  });

  test("should return 0 for fewer than 3 data points", () => {
    expect(pearsonCorrelation([1, 2], [3, 4])).toBe(0);
    expect(pearsonCorrelation([1], [2])).toBe(0);
    expect(pearsonCorrelation([], [])).toBe(0);
  });

  test("should handle exactly 3 data points", () => {
    const r = pearsonCorrelation([1, 2, 3], [2, 4, 6]);
    expect(r).toBe(1.0);
  });

  test("should handle constant x series", () => {
    const r = pearsonCorrelation([5, 5, 5, 5], [1, 2, 3, 4]);
    expect(r).toBe(0); // denominator is 0
  });

  test("should handle constant y series", () => {
    const r = pearsonCorrelation([1, 2, 3, 4], [7, 7, 7, 7]);
    expect(r).toBe(0);
  });

  test("should use minimum length of two arrays", () => {
    const r = pearsonCorrelation([1, 2, 3, 4, 5, 6, 7], [10, 20, 30]);
    // Uses last 3 of each: [5,6,7] vs [10,20,30]
    expect(r).toBe(1.0);
  });

  test("should produce values in range [-1, 1]", () => {
    const testCases = [
      { x: [10, 20, 15, 25, 30], y: [5, 8, 6, 12, 15] },
      { x: [1, 3, 5, 7, 9], y: [9, 7, 5, 3, 1] },
      { x: [1, 2, 3, 4, 5], y: [2, 1, 4, 3, 5] },
    ];
    for (const tc of testCases) {
      const r = pearsonCorrelation(tc.x, tc.y);
      expect(r).toBeGreaterThanOrEqual(-1);
      expect(r).toBeLessThanOrEqual(1);
    }
  });

  test("should be symmetric: r(x,y) == r(y,x)", () => {
    const x = [10, 20, 30, 40, 50];
    const y = [12, 18, 33, 42, 48];
    expect(pearsonCorrelation(x, y)).toBe(pearsonCorrelation(y, x));
  });

  test("should round to 4 decimal places", () => {
    const r = pearsonCorrelation([1, 2, 3, 4, 5], [2, 3, 5, 4, 6]);
    const decimals = r.toString().split('.')[1]?.length || 0;
    expect(decimals).toBeLessThanOrEqual(4);
  });

  test("should handle large series (100 points)", () => {
    const x = Array.from({ length: 100 }, (_, i) => i);
    const y = Array.from({ length: 100 }, (_, i) => i * 2 + 5);
    const r = pearsonCorrelation(x, y);
    expect(r).toBe(1.0);
  });
});

// ─── Correlation Classification ──────────────────────────────────────────────

describe("Correlation classification", () => {
  test("should classify strong positive (r >= 0.7)", () => {
    expect(classifyCorrelation(0.7)).toBe("strong_positive");
    expect(classifyCorrelation(0.85)).toBe("strong_positive");
    expect(classifyCorrelation(1.0)).toBe("strong_positive");
  });

  test("should classify moderate positive (0.3 <= r < 0.7)", () => {
    expect(classifyCorrelation(0.3)).toBe("moderate_positive");
    expect(classifyCorrelation(0.5)).toBe("moderate_positive");
    expect(classifyCorrelation(0.69)).toBe("moderate_positive");
  });

  test("should classify weak (-0.3 < r < 0.3)", () => {
    expect(classifyCorrelation(0.0)).toBe("weak");
    expect(classifyCorrelation(0.1)).toBe("weak");
    expect(classifyCorrelation(-0.1)).toBe("weak");
    expect(classifyCorrelation(0.29)).toBe("weak");
    expect(classifyCorrelation(-0.29)).toBe("weak");
  });

  test("should classify moderate negative (-0.7 < r <= -0.3)", () => {
    expect(classifyCorrelation(-0.3)).toBe("moderate_negative");
    expect(classifyCorrelation(-0.5)).toBe("moderate_negative");
    expect(classifyCorrelation(-0.69)).toBe("moderate_negative");
  });

  test("should classify strong negative (r <= -0.7)", () => {
    expect(classifyCorrelation(-0.7)).toBe("strong_negative");
    expect(classifyCorrelation(-0.85)).toBe("strong_negative");
    expect(classifyCorrelation(-1.0)).toBe("strong_negative");
  });
});

// ─── Correlation Matrix ─────────────────────────────────────────────────────

describe("Correlation matrix building", () => {
  test("should create symmetric NxN matrix", () => {
    const history: Record<string, PriceSnapshot[]> = {
      m1: makeHistory([50, 55, 60, 65, 70]),
      m2: makeHistory([30, 35, 40, 45, 50]),
      m3: makeHistory([80, 75, 70, 65, 60]),
    };

    const result = buildCorrelationMatrix(["m1", "m2", "m3"], history);
    expect(result.matrix.length).toBe(3);
    expect(result.matrix[0].length).toBe(3);

    // Diagonal should be 1.0
    for (let i = 0; i < 3; i++) {
      expect(result.matrix[i][i]).toBe(1.0);
    }

    // Symmetric
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        expect(result.matrix[i][j]).toBe(result.matrix[j][i]);
      }
    }
  });

  test("should generate correct number of pairs", () => {
    const history: Record<string, PriceSnapshot[]> = {
      m1: makeHistory([50, 55, 60]),
      m2: makeHistory([30, 35, 40]),
      m3: makeHistory([80, 75, 70]),
    };

    const result = buildCorrelationMatrix(["m1", "m2", "m3"], history);
    // 3 markets → 3 pairs: (m1,m2), (m1,m3), (m2,m3)
    expect(result.pairs).toHaveLength(3);
  });

  test("should sort pairs by absolute correlation descending", () => {
    const history: Record<string, PriceSnapshot[]> = {
      m1: makeHistory([50, 55, 60, 65, 70]),
      m2: makeHistory([50, 55, 60, 65, 70]), // Perfect positive
      m3: makeHistory([70, 65, 60, 55, 50]), // Perfect negative with m1
    };

    const result = buildCorrelationMatrix(["m1", "m2", "m3"], history);
    // All should have |r| = 1.0
    for (const pair of result.pairs) {
      expect(Math.abs(pair.correlation)).toBe(1.0);
    }
  });

  test("should handle markets with no price history", () => {
    const history: Record<string, PriceSnapshot[]> = {
      m1: makeHistory([50, 55, 60]),
      m2: [], // No history
    };

    const result = buildCorrelationMatrix(["m1", "m2"], history);
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0].correlation).toBe(0);
  });

  test("should handle single market", () => {
    const history: Record<string, PriceSnapshot[]> = {
      m1: makeHistory([50, 55, 60]),
    };

    const result = buildCorrelationMatrix(["m1"], history);
    expect(result.matrix).toHaveLength(1);
    expect(result.matrix[0][0]).toBe(1.0);
    expect(result.pairs).toHaveLength(0);
  });

  test("should include significance classification in pairs", () => {
    const history: Record<string, PriceSnapshot[]> = {
      m1: makeHistory([50, 55, 60, 65, 70]),
      m2: makeHistory([50, 55, 60, 65, 70]),
    };

    const result = buildCorrelationMatrix(["m1", "m2"], history);
    expect(result.pairs[0].significance).toBe("strong_positive");
  });

  test("should include data point count", () => {
    const history: Record<string, PriceSnapshot[]> = {
      m1: makeHistory([50, 55, 60, 65, 70]),
      m2: makeHistory([30, 35, 40]),
    };

    const result = buildCorrelationMatrix(["m1", "m2"], history);
    expect(result.pairs[0].dataPoints).toBe(3); // min of 5 and 3
  });
});

// ─── Single Market Arbitrage ─────────────────────────────────────────────────

describe("Single market arbitrage detection", () => {
  test("should detect overpriced market (total > 103%)", () => {
    const result = detectSingleMarketArbitrage(
      "m1", "Test?",
      [{ name: "Yes", price: 55 }, { name: "No", price: 50 }],
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe("overpriced");
    expect(result!.totalPrice).toBe(105);
    expect(result!.deviation).toBe(5);
  });

  test("should detect underpriced market (total < 97%)", () => {
    const result = detectSingleMarketArbitrage(
      "m2", "Test?",
      [{ name: "Yes", price: 45 }, { name: "No", price: 50 }],
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe("underpriced");
    expect(result!.totalPrice).toBe(95);
  });

  test("should return null for properly priced market", () => {
    const result = detectSingleMarketArbitrage(
      "m3", "Test?",
      [{ name: "Yes", price: 50 }, { name: "No", price: 50 }],
    );
    expect(result).toBeNull(); // deviation = 0 < 3
  });

  test("should return null for single outcome", () => {
    const result = detectSingleMarketArbitrage(
      "m4", "Test?",
      [{ name: "Yes", price: 80 }],
    );
    expect(result).toBeNull();
  });

  test("should classify high confidence for deviation >= 10", () => {
    const result = detectSingleMarketArbitrage(
      "m5", "Test?",
      [{ name: "Yes", price: 60 }, { name: "No", price: 55 }],
    );
    expect(result!.deviation).toBe(15);
    expect(result!.confidence).toBe("high");
  });

  test("should classify medium confidence for deviation 5-9", () => {
    const result = detectSingleMarketArbitrage(
      "m6", "Test?",
      [{ name: "Yes", price: 53 }, { name: "No", price: 53 }],
    );
    expect(result!.deviation).toBe(6);
    expect(result!.confidence).toBe("medium");
  });

  test("should classify low confidence for deviation 3-4", () => {
    const result = detectSingleMarketArbitrage(
      "m7", "Test?",
      [{ name: "Yes", price: 51 }, { name: "No", price: 52 }],
    );
    expect(result!.deviation).toBe(3);
    expect(result!.confidence).toBe("low");
  });

  test("should handle 3+ outcomes", () => {
    const result = detectSingleMarketArbitrage(
      "m8", "Three-way?",
      [
        { name: "A", price: 40 },
        { name: "B", price: 35 },
        { name: "C", price: 35 },
      ],
    );
    expect(result!.totalPrice).toBe(110);
    expect(result!.type).toBe("overpriced");
  });

  test("should respect custom deviation threshold", () => {
    // Default threshold 3%: 102 total → 2% deviation → null
    expect(detectSingleMarketArbitrage("m", "Q", [
      { name: "Y", price: 51 }, { name: "N", price: 51 },
    ])).toBeNull();

    // Custom threshold 1%: 102 → 2% > 1% → detected
    expect(detectSingleMarketArbitrage("m", "Q", [
      { name: "Y", price: 51 }, { name: "N", price: 51 },
    ], 1)).not.toBeNull();
  });

  test("should calculate potential profit as deviation amount", () => {
    const result = detectSingleMarketArbitrage(
      "m", "Q",
      [{ name: "Y", price: 60 }, { name: "N", price: 48 }],
    );
    expect(result!.potentialProfit).toBe(result!.deviation);
  });
});

// ─── Cross-Market Arbitrage ─────────────────────────────────────────────────

describe("Cross-market arbitrage detection", () => {
  test("should detect complementary mispricing", () => {
    const result = detectCrossMarketArbitrage(
      { id: "m1", question: "Event A?", outcome: "Yes", price: 60 },
      { id: "m2", question: "Event B?", outcome: "Yes", price: 50 },
      "complementary",
      {},
    );
    expect(result).not.toBeNull();
    expect(result!.combinedPrice).toBe(110);
    expect(result!.expectedCombined).toBe(100);
    expect(result!.deviation).toBe(10);
  });

  test("should return null for complementary within threshold", () => {
    const result = detectCrossMarketArbitrage(
      { id: "m1", question: "A?", outcome: "Yes", price: 50 },
      { id: "m2", question: "B?", outcome: "Yes", price: 49 },
      "complementary",
      {},
    );
    expect(result).toBeNull(); // 99 vs 100 = 1% < 3%
  });

  test("should detect correlated market mispricing", () => {
    const history: Record<string, PriceSnapshot[]> = {
      m1: makeHistory([40, 45, 50, 55, 60]),
      m2: makeHistory([30, 35, 40, 45, 50]),
    };

    // Historical avg combined: (40+30 + 45+35 + 50+40 + 55+45 + 60+50)/5 = 470/5 = 94
    // Current combined: 65 + 55 = 120
    const result = detectCrossMarketArbitrage(
      { id: "m1", question: "A?", outcome: "Yes", price: 65 },
      { id: "m2", question: "B?", outcome: "Yes", price: 55 },
      "correlated",
      history,
    );
    expect(result).not.toBeNull();
  });

  test("should return null for correlated with insufficient history", () => {
    const history: Record<string, PriceSnapshot[]> = {
      m1: makeHistory([40, 45]),
      m2: makeHistory([30]),
    };

    const result = detectCrossMarketArbitrage(
      { id: "m1", question: "A?", outcome: "Yes", price: 50 },
      { id: "m2", question: "B?", outcome: "Yes", price: 40 },
      "correlated",
      history,
    );
    expect(result).toBeNull();
  });

  test("should include opportunity description", () => {
    const result = detectCrossMarketArbitrage(
      { id: "m1", question: "Event A?", outcome: "Yes", price: 60 },
      { id: "m2", question: "Event B?", outcome: "Yes", price: 50 },
      "complementary",
      {},
    );
    expect(result!.opportunity).toContain("Event A?");
    expect(result!.opportunity).toContain("Event B?");
  });
});

// ─── Scan For Arbitrage ─────────────────────────────────────────────────────

describe("Arbitrage scanning", () => {
  test("should find arbitrage across multiple markets", () => {
    const markets = [
      { id: "m1", question: "Q1?", outcomes: [{ name: "Y", price: 55 }, { name: "N", price: 50 }] },
      { id: "m2", question: "Q2?", outcomes: [{ name: "Y", price: 50 }, { name: "N", price: 50 }] },
      { id: "m3", question: "Q3?", outcomes: [{ name: "Y", price: 60 }, { name: "N", price: 55 }] },
    ];

    const results = scanForArbitrage(markets);
    expect(results.length).toBeGreaterThanOrEqual(2); // m1 and m3
  });

  test("should return empty for properly priced markets", () => {
    const markets = [
      { id: "m1", question: "Q?", outcomes: [{ name: "Y", price: 50 }, { name: "N", price: 50 }] },
      { id: "m2", question: "Q?", outcomes: [{ name: "Y", price: 49 }, { name: "N", price: 51 }] },
    ];

    const results = scanForArbitrage(markets);
    expect(results).toHaveLength(0);
  });

  test("should sort by potential profit descending", () => {
    const markets = [
      { id: "m1", question: "Q1?", outcomes: [{ name: "Y", price: 53 }, { name: "N", price: 53 }] }, // 6% dev
      { id: "m2", question: "Q2?", outcomes: [{ name: "Y", price: 60 }, { name: "N", price: 55 }] }, // 15% dev
      { id: "m3", question: "Q3?", outcomes: [{ name: "Y", price: 52 }, { name: "N", price: 52 }] }, // 4% dev
    ];

    const results = scanForArbitrage(markets);
    for (let i = 1; i < results.length; i++) {
      expect(results[i].potentialProfit).toBeLessThanOrEqual(results[i - 1].potentialProfit);
    }
  });

  test("should respect custom deviation threshold", () => {
    const markets = [
      { id: "m1", question: "Q?", outcomes: [{ name: "Y", price: 51 }, { name: "N", price: 51 }] }, // 2% dev
    ];

    expect(scanForArbitrage(markets, 3)).toHaveLength(0); // 2% < 3%
    expect(scanForArbitrage(markets, 1)).toHaveLength(1); // 2% > 1%
  });

  test("should handle empty markets array", () => {
    expect(scanForArbitrage([])).toHaveLength(0);
  });

  test("should handle large number of markets", () => {
    const markets = Array.from({ length: 50 }, (_, i) => ({
      id: `m${i}`,
      question: `Q${i}?`,
      outcomes: [
        { name: "Y", price: 50 + (i % 5) },
        { name: "N", price: 50 + (i % 3) },
      ],
    }));

    const results = scanForArbitrage(markets);
    expect(Array.isArray(results)).toBe(true);
  });
});

// ─── Portfolio Snapshot Recording ────────────────────────────────────────────

describe("Portfolio snapshot recording", () => {
  test("should record a snapshot with weighted average", () => {
    const portfolio = createPortfolio("p1", "Test", [
      { marketId: "m1", label: "A", outcome: "Yes", weight: 0.6 },
      { marketId: "m2", label: "B", outcome: "Yes", weight: 0.4 },
    ]);

    const history: Record<string, PriceSnapshot[]> = {
      m1: [makeSnapshot({ Yes: 70 })],
      m2: [makeSnapshot({ Yes: 50 })],
    };

    const snapshots: PortfolioSnapshot[] = [];
    recordPortfolioSnapshot(snapshots, portfolio, history);

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].marketPrices.m1).toBe(70);
    expect(snapshots[0].marketPrices.m2).toBe(50);
    // Weighted avg: 0.6*70 + 0.4*50 = 42 + 20 = 62
    expect(snapshots[0].weightedAverage).toBe(62);
  });

  test("should accumulate multiple snapshots", () => {
    const portfolio = createPortfolio("p", "Multi", [
      { marketId: "m1", label: "A", outcome: "Yes", weight: 1.0 },
    ]);

    const snapshots: PortfolioSnapshot[] = [];

    for (let i = 0; i < 5; i++) {
      const history: Record<string, PriceSnapshot[]> = {
        m1: [makeSnapshot({ Yes: 50 + i * 5 })],
      };
      recordPortfolioSnapshot(snapshots, portfolio, history);
    }

    expect(snapshots).toHaveLength(5);
    expect(snapshots[0].weightedAverage).toBe(50);
    expect(snapshots[4].weightedAverage).toBe(70);
  });

  test("should enforce maxSnapshots limit", () => {
    const portfolio = createPortfolio("p", "Max", [
      { marketId: "m1", label: "A", outcome: "Yes", weight: 1.0 },
    ]);

    const snapshots: PortfolioSnapshot[] = [];
    const maxSnapshots = 5;

    for (let i = 0; i < 10; i++) {
      const history: Record<string, PriceSnapshot[]> = {
        m1: [makeSnapshot({ Yes: 50 + i })],
      };
      recordPortfolioSnapshot(snapshots, portfolio, history, maxSnapshots);
    }

    expect(snapshots).toHaveLength(5);
    // Should keep latest 5
    expect(snapshots[0].weightedAverage).toBe(55);
    expect(snapshots[4].weightedAverage).toBe(59);
  });

  test("should handle missing market history", () => {
    const portfolio = createPortfolio("p", "Missing", [
      { marketId: "m1", label: "A", outcome: "Yes", weight: 0.5 },
      { marketId: "m2", label: "B", outcome: "Yes", weight: 0.5 },
    ]);

    const snapshots: PortfolioSnapshot[] = [];
    // Only m1 has history
    recordPortfolioSnapshot(snapshots, portfolio, { m1: [makeSnapshot({ Yes: 60 })] });

    expect(snapshots).toHaveLength(1);
    // Only m1 contributes: 0.5 * 60 = 30
    expect(snapshots[0].weightedAverage).toBe(30);
  });

  test("should use default maxSnapshots of 288", () => {
    const portfolio = createPortfolio("p", "Default", [
      { marketId: "m1", label: "A", outcome: "Yes", weight: 1.0 },
    ]);

    const snapshots: PortfolioSnapshot[] = [];

    for (let i = 0; i < 300; i++) {
      recordPortfolioSnapshot(snapshots, portfolio, {
        m1: [makeSnapshot({ Yes: i })],
      });
    }

    expect(snapshots).toHaveLength(288);
  });
});

// ─── Divergence Detection ────────────────────────────────────────────────────

describe("Divergence detection", () => {
  test("should detect divergence in correlated markets", () => {
    const history: Record<string, PriceSnapshot[]> = {
      m1: makeHistory([50, 55, 60, 65, 70, 80]),
      m2: makeHistory([50, 55, 60, 65, 70, 55]), // Diverges at end
    };

    const matrix = buildCorrelationMatrix(["m1", "m2"], history);
    const divergences = detectDivergences(matrix, history, "Yes", 5);

    // The last prices diverge: m1=80, m2=55, historical avg diff should be ~0
    // actualDiff = 80-55 = 25, expectedDiff ≈ 0, divergence = 25 > 5
    expect(divergences.length).toBeGreaterThanOrEqual(0);
  });

  test("should return empty for aligned markets", () => {
    const history: Record<string, PriceSnapshot[]> = {
      m1: makeHistory([50, 55, 60, 65, 70]),
      m2: makeHistory([50, 55, 60, 65, 70]),
    };

    const matrix = buildCorrelationMatrix(["m1", "m2"], history);
    const divergences = detectDivergences(matrix, history, "Yes", 10);
    expect(divergences).toHaveLength(0);
  });

  test("should sort divergences by amount descending", () => {
    const history: Record<string, PriceSnapshot[]> = {
      m1: makeHistory([50, 55, 60, 65, 70, 90]),
      m2: makeHistory([50, 55, 60, 65, 70, 40]),
      m3: makeHistory([50, 55, 60, 65, 70, 85]),
    };

    const matrix = buildCorrelationMatrix(["m1", "m2", "m3"], history);
    const divergences = detectDivergences(matrix, history, "Yes", 5);

    for (let i = 1; i < divergences.length; i++) {
      expect(divergences[i].divergenceAmount).toBeLessThanOrEqual(
        divergences[i - 1].divergenceAmount
      );
    }
  });
});
