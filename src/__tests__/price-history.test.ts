/**
 * Tests for Price History Tracking & Trend Analysis
 *
 * Tests the CRE-powered price history recording, trend detection,
 * momentum classification, and volatility calculation features.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import {
  recordPriceSnapshot,
  analyzeTrend,
} from "../polymarket-alert-workflow";
import type { PriceSnapshot } from "../polymarket-alert-workflow";

// Helper to create a snapshot at a specific time
function snap(timestamp: number, yesPrice: number, noPrice?: number): PriceSnapshot {
  return {
    timestamp,
    prices: {
      Yes: yesPrice,
      No: noPrice ?? (100 - yesPrice),
    },
  };
}

// Helper to create a market object
function makeMarket(yesPrice: number, noPrice?: number) {
  return {
    condition_id: "0xTEST",
    question: "Test market?",
    outcomes: ["Yes", "No"],
    tokens: [
      { token_id: "t1", outcome: "Yes", price: yesPrice / 100 },
      { token_id: "t2", outcome: "No", price: (noPrice ?? (100 - yesPrice)) / 100 },
    ],
    active: true,
    closed: false,
  };
}

describe("recordPriceSnapshot", () => {
  test("creates history for new market", () => {
    const history: Record<string, PriceSnapshot[]> = {};
    recordPriceSnapshot(history, "m1", makeMarket(65));
    expect(history["m1"]).toBeDefined();
    expect(history["m1"].length).toBe(1);
    expect(history["m1"][0].prices["Yes"]).toBeCloseTo(65, 1);
    expect(history["m1"][0].prices["No"]).toBeCloseTo(35, 1);
  });

  test("appends to existing history", () => {
    const history: Record<string, PriceSnapshot[]> = {};
    recordPriceSnapshot(history, "m1", makeMarket(60));
    recordPriceSnapshot(history, "m1", makeMarket(62));
    recordPriceSnapshot(history, "m1", makeMarket(64));
    expect(history["m1"].length).toBe(3);
  });

  test("trims history when exceeding maxSnapshots", () => {
    const history: Record<string, PriceSnapshot[]> = {};
    for (let i = 0; i < 15; i++) {
      recordPriceSnapshot(history, "m1", makeMarket(50 + i), 10);
    }
    expect(history["m1"].length).toBe(10);
    // Should keep the latest 10
    expect(history["m1"][0].prices["Yes"]).toBeCloseTo(55, 1);
    expect(history["m1"][9].prices["Yes"]).toBeCloseTo(64, 1);
  });

  test("tracks multiple markets independently", () => {
    const history: Record<string, PriceSnapshot[]> = {};
    recordPriceSnapshot(history, "m1", makeMarket(60));
    recordPriceSnapshot(history, "m2", makeMarket(40));
    expect(history["m1"].length).toBe(1);
    expect(history["m2"].length).toBe(1);
    expect(history["m1"][0].prices["Yes"]).toBeCloseTo(60, 1);
    expect(history["m2"][0].prices["Yes"]).toBeCloseTo(40, 1);
  });

  test("records correct timestamp", () => {
    const history: Record<string, PriceSnapshot[]> = {};
    const before = Date.now();
    recordPriceSnapshot(history, "m1", makeMarket(50));
    const after = Date.now();
    expect(history["m1"][0].timestamp).toBeGreaterThanOrEqual(before);
    expect(history["m1"][0].timestamp).toBeLessThanOrEqual(after);
  });

  test("handles market with many outcomes", () => {
    const history: Record<string, PriceSnapshot[]> = {};
    const market = {
      condition_id: "0xMULTI",
      question: "Who wins?",
      outcomes: ["A", "B", "C"],
      tokens: [
        { token_id: "t1", outcome: "A", price: 0.4 },
        { token_id: "t2", outcome: "B", price: 0.35 },
        { token_id: "t3", outcome: "C", price: 0.25 },
      ],
      active: true,
      closed: false,
    };
    recordPriceSnapshot(history, "m1", market);
    expect(history["m1"][0].prices["A"]).toBeCloseTo(40, 1);
    expect(history["m1"][0].prices["B"]).toBeCloseTo(35, 1);
    expect(history["m1"][0].prices["C"]).toBeCloseTo(25, 1);
  });

  test("default maxSnapshots is 288 (24h of 5-min intervals)", () => {
    const history: Record<string, PriceSnapshot[]> = {};
    for (let i = 0; i < 300; i++) {
      recordPriceSnapshot(history, "m1", makeMarket(50));
    }
    expect(history["m1"].length).toBe(288);
  });

  test("handles zero prices", () => {
    const history: Record<string, PriceSnapshot[]> = {};
    recordPriceSnapshot(history, "m1", makeMarket(0, 100));
    expect(history["m1"][0].prices["Yes"]).toBe(0);
    expect(history["m1"][0].prices["No"]).toBeCloseTo(100, 1);
  });

  test("handles 100% prices", () => {
    const history: Record<string, PriceSnapshot[]> = {};
    recordPriceSnapshot(history, "m1", makeMarket(100, 0));
    expect(history["m1"][0].prices["Yes"]).toBeCloseTo(100, 1);
    expect(history["m1"][0].prices["No"]).toBe(0);
  });
});

describe("analyzeTrend", () => {
  const now = Date.now();

  test("returns stable for empty history", () => {
    const trend = analyzeTrend([], "Yes");
    expect(trend.momentum).toBe("stable");
    expect(trend.currentPrice).toBe(0);
    expect(trend.dataPoints).toBe(0);
    expect(trend.changePercent1h).toBeNull();
    expect(trend.changePercent6h).toBeNull();
    expect(trend.changePercent24h).toBeNull();
  });

  test("returns current price from latest snapshot", () => {
    const snapshots = [
      snap(now - 3600000, 50),
      snap(now - 1800000, 55),
      snap(now - 100, 60),
    ];
    const trend = analyzeTrend(snapshots, "Yes");
    expect(trend.currentPrice).toBe(60);
  });

  test("calculates 1-hour change correctly", () => {
    const snapshots = [
      snap(now - 3600000, 50),
      snap(now - 100, 60),
    ];
    const trend = analyzeTrend(snapshots, "Yes");
    expect(trend.changePercent1h).toBeCloseTo(10, 1);
  });

  test("calculates 6-hour change correctly", () => {
    const snapshots = [
      snap(now - 21600000, 40), // 6h ago
      snap(now - 3600000, 50),
      snap(now - 100, 60),
    ];
    const trend = analyzeTrend(snapshots, "Yes");
    expect(trend.changePercent6h).toBeCloseTo(20, 1);
  });

  test("calculates 24-hour change correctly", () => {
    const snapshots = [
      snap(now - 86400000, 30), // 24h ago
      snap(now - 21600000, 40),
      snap(now - 3600000, 50),
      snap(now - 100, 60),
    ];
    const trend = analyzeTrend(snapshots, "Yes");
    expect(trend.changePercent24h).toBeCloseTo(30, 1);
  });

  test("returns null for unavailable time windows", () => {
    // Only 30 min of data - 1h change should still work if snapshot is close enough
    const snapshots = [
      snap(now - 1800000, 55),
      snap(now - 100, 60),
    ];
    const trend = analyzeTrend(snapshots, "Yes");
    // 6h and 24h should be null
    expect(trend.changePercent6h).toBeNull();
    expect(trend.changePercent24h).toBeNull();
  });

  test("detects surging_up momentum (+5%)", () => {
    const snapshots = [
      snap(now - 3600000, 50),
      snap(now - 100, 56), // +6% in 1h
    ];
    const trend = analyzeTrend(snapshots, "Yes");
    expect(trend.momentum).toBe("surging_up");
  });

  test("detects trending_up momentum (+2-5%)", () => {
    const snapshots = [
      snap(now - 3600000, 50),
      snap(now - 100, 53), // +3% in 1h
    ];
    const trend = analyzeTrend(snapshots, "Yes");
    expect(trend.momentum).toBe("trending_up");
  });

  test("detects stable momentum (-2 to +2%)", () => {
    const snapshots = [
      snap(now - 3600000, 50),
      snap(now - 100, 51), // +1% in 1h
    ];
    const trend = analyzeTrend(snapshots, "Yes");
    expect(trend.momentum).toBe("stable");
  });

  test("detects trending_down momentum (-2 to -5%)", () => {
    const snapshots = [
      snap(now - 3600000, 50),
      snap(now - 100, 47), // -3% in 1h
    ];
    const trend = analyzeTrend(snapshots, "Yes");
    expect(trend.momentum).toBe("trending_down");
  });

  test("detects surging_down momentum (-5%+)", () => {
    const snapshots = [
      snap(now - 3600000, 50),
      snap(now - 100, 44), // -6% in 1h
    ];
    const trend = analyzeTrend(snapshots, "Yes");
    expect(trend.momentum).toBe("surging_down");
  });

  test("calculates volatility from recent prices", () => {
    // Stable prices → low volatility
    const stableSnapshots = Array.from({ length: 12 }, (_, i) =>
      snap(now - (12 - i) * 300000, 50)
    );
    const stableTrend = analyzeTrend(stableSnapshots, "Yes");
    expect(stableTrend.volatility).toBe(0);

    // Volatile prices → high volatility
    const volatileSnapshots = Array.from({ length: 12 }, (_, i) =>
      snap(now - (12 - i) * 300000, i % 2 === 0 ? 40 : 60)
    );
    const volatileTrend = analyzeTrend(volatileSnapshots, "Yes");
    expect(volatileTrend.volatility).toBeGreaterThan(5);
  });

  test("handles single data point", () => {
    const snapshots = [snap(now - 100, 55)];
    const trend = analyzeTrend(snapshots, "Yes");
    expect(trend.currentPrice).toBe(55);
    expect(trend.dataPoints).toBe(1);
    expect(trend.volatility).toBe(0);
  });

  test("filters by outcome correctly", () => {
    const snapshots = [
      snap(now - 3600000, 60, 40),
      snap(now - 100, 65, 35),
    ];
    const yesTrend = analyzeTrend(snapshots, "Yes");
    expect(yesTrend.currentPrice).toBe(65);

    const noTrend = analyzeTrend(snapshots, "No");
    expect(noTrend.currentPrice).toBe(35);
  });

  test("handles outcome not in snapshots", () => {
    const snapshots = [snap(now - 100, 50)];
    const trend = analyzeTrend(snapshots, "Maybe");
    expect(trend.dataPoints).toBe(0);
    expect(trend.momentum).toBe("stable");
  });

  test("returns correct dataPoints count", () => {
    const snapshots = Array.from({ length: 20 }, (_, i) =>
      snap(now - (20 - i) * 300000, 50 + i * 0.5)
    );
    const trend = analyzeTrend(snapshots, "Yes");
    expect(trend.dataPoints).toBe(20);
  });

  test("negative price change", () => {
    const snapshots = [
      snap(now - 3600000, 70),
      snap(now - 100, 60),
    ];
    const trend = analyzeTrend(snapshots, "Yes");
    expect(trend.changePercent1h).toBeCloseTo(-10, 1);
  });

  test("zero price change", () => {
    const snapshots = [
      snap(now - 3600000, 50),
      snap(now - 100, 50),
    ];
    const trend = analyzeTrend(snapshots, "Yes");
    expect(trend.changePercent1h).toBeCloseTo(0, 1);
    expect(trend.momentum).toBe("stable");
  });

  test("extreme price swing (0 to 100)", () => {
    const snapshots = [
      snap(now - 3600000, 0),
      snap(now - 100, 100),
    ];
    const trend = analyzeTrend(snapshots, "Yes");
    expect(trend.changePercent1h).toBeCloseTo(100, 1);
    expect(trend.momentum).toBe("surging_up");
  });

  test("extreme price swing (100 to 0)", () => {
    const snapshots = [
      snap(now - 3600000, 100),
      snap(now - 100, 0),
    ];
    const trend = analyzeTrend(snapshots, "Yes");
    expect(trend.changePercent1h).toBeCloseTo(-100, 1);
    expect(trend.momentum).toBe("surging_down");
  });

  test("timestamps are sorted correctly even when unordered input", () => {
    const snapshots = [
      snap(now - 100, 60),     // latest
      snap(now - 3600000, 50), // 1h ago
      snap(now - 1800000, 55), // 30m ago
    ];
    const trend = analyzeTrend(snapshots, "Yes");
    expect(trend.currentPrice).toBe(60);
    expect(trend.changePercent1h).toBeCloseTo(10, 1);
  });

  test("volatility with gradually increasing prices", () => {
    const snapshots = Array.from({ length: 12 }, (_, i) =>
      snap(now - (12 - i) * 300000, 50 + i)
    );
    const trend = analyzeTrend(snapshots, "Yes");
    // Linear increase has non-zero but moderate volatility
    expect(trend.volatility).toBeGreaterThan(0);
    expect(trend.volatility).toBeLessThan(10);
  });

  test("momentum boundary: exactly +2%", () => {
    const snapshots = [
      snap(now - 3600000, 50),
      snap(now - 100, 52),
    ];
    const trend = analyzeTrend(snapshots, "Yes");
    expect(trend.momentum).toBe("trending_up");
  });

  test("momentum boundary: exactly -2%", () => {
    const snapshots = [
      snap(now - 3600000, 50),
      snap(now - 100, 48),
    ];
    const trend = analyzeTrend(snapshots, "Yes");
    expect(trend.momentum).toBe("trending_down");
  });

  test("momentum boundary: exactly +5%", () => {
    const snapshots = [
      snap(now - 3600000, 50),
      snap(now - 100, 55),
    ];
    const trend = analyzeTrend(snapshots, "Yes");
    expect(trend.momentum).toBe("surging_up");
  });

  test("momentum boundary: exactly -5%", () => {
    const snapshots = [
      snap(now - 3600000, 50),
      snap(now - 100, 45),
    ];
    const trend = analyzeTrend(snapshots, "Yes");
    expect(trend.momentum).toBe("surging_down");
  });
});

describe("Trend Analysis - Time Window Selection", () => {
  const now = Date.now();

  test("uses closest snapshot within 20% tolerance", () => {
    // Snapshot at 50 min ago (within 20% of 1h = 12 min tolerance)
    const snapshots = [
      snap(now - 3000000, 50), // 50 min ago
      snap(now - 100, 60),
    ];
    const trend = analyzeTrend(snapshots, "Yes");
    expect(trend.changePercent1h).toBeCloseTo(10, 1);
  });

  test("rejects snapshot too far from target window", () => {
    // Only a snapshot at 30 min ago - too far from 1h target (20% = 12 min tolerance)
    // Actually 30 min = 1800000ms. Target for 1h is 3600000ms.
    // |1800000 - 3600000| = 1800000, which is > 3600000 * 0.2 = 720000
    // So this should return null
    const snapshots = [
      snap(now - 1800000, 50), // 30 min ago - too far from 1h target
      snap(now - 100, 60),
    ];
    const trend = analyzeTrend(snapshots, "Yes");
    // 1h change should be null since no snapshot near 1h ago
    expect(trend.changePercent1h).toBeNull();
  });

  test("picks closest of multiple snapshots near target", () => {
    const snapshots = [
      snap(now - 3700000, 48), // 61.7 min ago
      snap(now - 3500000, 52), // 58.3 min ago (closer to 1h)
      snap(now - 100, 60),
    ];
    const trend = analyzeTrend(snapshots, "Yes");
    // Should use 58.3 min snapshot (52%)
    expect(trend.changePercent1h).toBeCloseTo(8, 1);
  });
});

describe("Trend Analysis - Volatility Edge Cases", () => {
  const now = Date.now();

  test("very small price differences produce small volatility", () => {
    const snapshots = Array.from({ length: 12 }, (_, i) =>
      snap(now - (12 - i) * 300000, 50 + (i % 2 === 0 ? 0.1 : -0.1))
    );
    const trend = analyzeTrend(snapshots, "Yes");
    expect(trend.volatility).toBeLessThan(1);
  });

  test("all same price produces zero volatility", () => {
    const snapshots = Array.from({ length: 12 }, (_, i) =>
      snap(now - (12 - i) * 300000, 50)
    );
    const trend = analyzeTrend(snapshots, "Yes");
    expect(trend.volatility).toBe(0);
  });

  test("uses only last 12 snapshots for volatility", () => {
    // Old wild swings, recent stability
    const oldSnapshots = Array.from({ length: 20 }, (_, i) =>
      snap(now - (32 - i) * 300000, i % 2 === 0 ? 20 : 80)
    );
    const recentSnapshots = Array.from({ length: 12 }, (_, i) =>
      snap(now - (12 - i) * 300000, 50)
    );
    const snapshots = [...oldSnapshots, ...recentSnapshots];
    const trend = analyzeTrend(snapshots, "Yes");
    // Volatility should be based on recent stable prices
    expect(trend.volatility).toBe(0);
  });

  test("two data points has volatility", () => {
    const snapshots = [
      snap(now - 600000, 40),
      snap(now - 100, 60),
    ];
    const trend = analyzeTrend(snapshots, "Yes");
    // mean = 50, variance = (100 + 100) / 2 = 100, std = 10
    expect(trend.volatility).toBe(10);
  });
});

describe("Price History with Multiple Outcomes", () => {
  test("tracks Yes and No prices independently", () => {
    const history: Record<string, PriceSnapshot[]> = {};
    recordPriceSnapshot(history, "m1", makeMarket(60, 40));
    recordPriceSnapshot(history, "m1", makeMarket(65, 35));

    const yesTrend = analyzeTrend(history["m1"], "Yes");
    const noTrend = analyzeTrend(history["m1"], "No");

    expect(yesTrend.currentPrice).toBeCloseTo(65, 1);
    expect(noTrend.currentPrice).toBeCloseTo(35, 1);
  });

  test("price history preserves chronological order", () => {
    const history: Record<string, PriceSnapshot[]> = {};
    recordPriceSnapshot(history, "m1", makeMarket(50));
    recordPriceSnapshot(history, "m1", makeMarket(55));
    recordPriceSnapshot(history, "m1", makeMarket(60));

    expect(history["m1"][0].prices["Yes"]).toBeCloseTo(50, 1);
    expect(history["m1"][1].prices["Yes"]).toBeCloseTo(55, 1);
    expect(history["m1"][2].prices["Yes"]).toBeCloseTo(60, 1);
  });
});

describe("Trend-Based Alert Scenarios", () => {
  const now = Date.now();

  test("election market surge detected", () => {
    // Simulate a candidate's odds jumping from 45% to 58% in an hour
    const snapshots = [
      snap(now - 3600000, 45),
      snap(now - 2700000, 47),
      snap(now - 1800000, 50),
      snap(now - 900000, 54),
      snap(now - 100, 58),
    ];
    const trend = analyzeTrend(snapshots, "Yes");
    expect(trend.momentum).toBe("surging_up");
    expect(trend.changePercent1h).toBeCloseTo(13, 1);
  });

  test("market crash detected", () => {
    // Simulate odds dropping from 70% to 35% in an hour
    const snapshots = [
      snap(now - 3600000, 70),
      snap(now - 2400000, 60),
      snap(now - 1200000, 45),
      snap(now - 100, 35),
    ];
    const trend = analyzeTrend(snapshots, "Yes");
    expect(trend.momentum).toBe("surging_down");
    expect(trend.changePercent1h).toBeCloseTo(-35, 1);
  });

  test("sideways trading detected", () => {
    // Price oscillating around 50% with small moves
    const snapshots = Array.from({ length: 12 }, (_, i) =>
      snap(now - (12 - i) * 300000, 50 + Math.sin(i) * 0.5)
    );
    // Add reference 1h ago point
    snapshots.unshift(snap(now - 3600000, 50));
    const trend = analyzeTrend(snapshots, "Yes");
    expect(trend.momentum).toBe("stable");
  });

  test("gradual uptrend over 24 hours", () => {
    const snapshots = [
      snap(now - 86400000, 30), // 24h ago: 30%
      snap(now - 21600000, 40), // 6h ago: 40%
      snap(now - 3600000, 48),  // 1h ago: 48%
      snap(now - 100, 50),      // now: 50%
    ];
    const trend = analyzeTrend(snapshots, "Yes");
    expect(trend.changePercent24h).toBeCloseTo(20, 1);
    expect(trend.changePercent6h).toBeCloseTo(10, 1);
    expect(trend.changePercent1h).toBeCloseTo(2, 1);
    expect(trend.momentum).toBe("trending_up");
  });

  test("high volatility with no net change", () => {
    // Wild swings but returns to starting price
    const snapshots = [
      snap(now - 3600000, 50),
      snap(now - 3000000, 70),
      snap(now - 2400000, 30),
      snap(now - 1800000, 65),
      snap(now - 1200000, 35),
      snap(now - 600000, 60),
      snap(now - 100, 50),
    ];
    const trend = analyzeTrend(snapshots, "Yes");
    expect(trend.changePercent1h).toBeCloseTo(0, 1);
    expect(trend.momentum).toBe("stable");
    expect(trend.volatility).toBeGreaterThan(5);
  });
});

describe("recordPriceSnapshot - Stress Tests", () => {
  test("handles rapid sequential snapshots", () => {
    const history: Record<string, PriceSnapshot[]> = {};
    for (let i = 0; i < 100; i++) {
      recordPriceSnapshot(history, "m1", makeMarket(50 + Math.random() * 10));
    }
    expect(history["m1"].length).toBe(100);
  });

  test("handles many markets simultaneously", () => {
    const history: Record<string, PriceSnapshot[]> = {};
    for (let i = 0; i < 50; i++) {
      recordPriceSnapshot(history, `market_${i}`, makeMarket(30 + i));
    }
    expect(Object.keys(history).length).toBe(50);
    expect(history["market_0"][0].prices["Yes"]).toBeCloseTo(30, 1);
    expect(history["market_49"][0].prices["Yes"]).toBeCloseTo(79, 1);
  });

  test("handles maxSnapshots of 1", () => {
    const history: Record<string, PriceSnapshot[]> = {};
    recordPriceSnapshot(history, "m1", makeMarket(50), 1);
    recordPriceSnapshot(history, "m1", makeMarket(60), 1);
    recordPriceSnapshot(history, "m1", makeMarket(70), 1);
    expect(history["m1"].length).toBe(1);
    expect(history["m1"][0].prices["Yes"]).toBeCloseTo(70, 1);
  });

  test("handles market with no tokens gracefully", () => {
    const history: Record<string, PriceSnapshot[]> = {};
    const emptyMarket = {
      condition_id: "0xEMPTY",
      question: "Empty?",
      outcomes: [],
      tokens: [],
      active: true,
      closed: false,
    };
    recordPriceSnapshot(history, "m1", emptyMarket);
    expect(history["m1"].length).toBe(1);
    expect(Object.keys(history["m1"][0].prices).length).toBe(0);
  });
});

describe("analyzeTrend - Large Dataset", () => {
  const now = Date.now();

  test("handles 288 data points (full 24h at 5-min intervals)", () => {
    const snapshots = Array.from({ length: 288 }, (_, i) => {
      // Simulate a sine wave pattern
      const price = 50 + 10 * Math.sin(i * Math.PI / 36);
      return snap(now - (288 - i) * 300000, price);
    });
    const trend = analyzeTrend(snapshots, "Yes");
    expect(trend.dataPoints).toBe(288);
    expect(trend.currentPrice).toBeGreaterThan(0);
    expect(trend.volatility).toBeGreaterThan(0);
  });

  test("handles 1000+ data points efficiently", () => {
    const snapshots = Array.from({ length: 1000 }, (_, i) =>
      snap(now - (1000 - i) * 60000, 50 + Math.random() * 20)
    );
    const start = performance.now();
    const trend = analyzeTrend(snapshots, "Yes");
    const elapsed = performance.now() - start;
    expect(trend.dataPoints).toBe(1000);
    expect(elapsed).toBeLessThan(100); // Should complete in <100ms
  });
});
