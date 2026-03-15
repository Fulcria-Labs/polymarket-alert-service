/**
 * Trend Reversal Scenario Tests
 *
 * Covers rapid reversals, multiple momentum flips, gaps in price history,
 * gradual trend changes, flash crash/recovery, trending then spike,
 * and price boundary edge cases.
 */
import { describe, test, expect } from 'bun:test';
import { analyzeTrend, recordPriceSnapshot } from '../polymarket-alert-workflow';
import type { PriceSnapshot, TrendAnalysis } from '../polymarket-alert-workflow';

// Helper to create a snapshot at an absolute timestamp
function snap(timestamp: number, yesPrice: number, noPrice?: number): PriceSnapshot {
  return {
    timestamp,
    prices: {
      Yes: yesPrice,
      No: noPrice ?? (100 - yesPrice),
    },
  };
}

// Helper: generate snapshots at 5-min intervals ending at `now`
function makeSnapshots(
  yesPrices: number[],
  intervalMs: number = 300000,
  baseTime?: number,
): PriceSnapshot[] {
  const now = baseTime ?? Date.now();
  return yesPrices.map((p, i) => snap(now - (yesPrices.length - 1 - i) * intervalMs, p));
}

// ─── Surging Up Then Sudden Crash ──────────────────────────────────────────

describe('Surging Up → Sudden Crash', () => {
  test('identifies crash after steady surge', () => {
    const now = Date.now();
    // 12 data points over 1 hour: steady climb then sudden crash at the end
    const prices = [50, 53, 56, 59, 62, 65, 68, 71, 74, 77, 80, 40];
    const snapshots = makeSnapshots(prices, 300000, now);

    const trend = analyzeTrend(snapshots, 'Yes');
    expect(trend.currentPrice).toBe(40);
    expect(trend.dataPoints).toBe(12);
    // Volatility should be elevated due to the crash
    expect(trend.volatility).toBeGreaterThan(0);
  });

  test('crash momentum shows surging_down when 1h change exceeds -5', () => {
    const now = Date.now();
    // Place prices 1 hour apart so analyzeTrend can find the 1h-ago price
    const snapshots = [
      snap(now - 3600000, 80), // 1h ago: 80%
      snap(now - 1800000, 75), // 30m ago
      snap(now - 900000, 70),  // 15m ago
      snap(now - 100, 40),     // now: 40% (crash of -40 in 1h)
    ];

    const trend = analyzeTrend(snapshots, 'Yes');
    expect(trend.momentum).toBe('surging_down');
    expect(trend.changePercent1h).toBeLessThan(-5);
  });

  test('rapid V-shaped recovery after crash', () => {
    const now = Date.now();
    const snapshots = [
      snap(now - 3600000, 70),  // Start at 70
      snap(now - 2700000, 65),
      snap(now - 1800000, 30),  // Crash to 30
      snap(now - 900000, 50),   // Recovery
      snap(now - 100, 68),      // Near original
    ];

    const trend = analyzeTrend(snapshots, 'Yes');
    expect(trend.currentPrice).toBe(68);
    // High volatility from the V-shape
    expect(trend.volatility).toBeGreaterThan(5);
  });

  test('crash from 99% to 1%', () => {
    const now = Date.now();
    const snapshots = [
      snap(now - 3600000, 99),
      snap(now - 2400000, 80),
      snap(now - 1200000, 50),
      snap(now - 100, 1),
    ];

    const trend = analyzeTrend(snapshots, 'Yes');
    expect(trend.currentPrice).toBe(1);
    expect(trend.momentum).toBe('surging_down');
  });
});

// ─── Volatile Markets with Multiple Momentum Flips ─────────────────────────

describe('Volatile Markets - Multiple Momentum Flips', () => {
  test('alternating high-low produces high volatility', () => {
    const now = Date.now();
    const prices = [30, 70, 30, 70, 30, 70, 30, 70, 30, 70, 30, 70];
    const snapshots = makeSnapshots(prices, 300000, now);

    const trend = analyzeTrend(snapshots, 'Yes');
    expect(trend.volatility).toBeGreaterThan(15);
  });

  test('gradual oscillation has moderate volatility', () => {
    const now = Date.now();
    const prices = [50, 55, 50, 55, 50, 55, 50, 55];
    const snapshots = makeSnapshots(prices, 300000, now);

    const trend = analyzeTrend(snapshots, 'Yes');
    expect(trend.volatility).toBeGreaterThan(0);
    expect(trend.volatility).toBeLessThan(20);
  });

  test('three momentum flips in one window', () => {
    const now = Date.now();
    // up → down → up within the analysis window
    const snapshots = [
      snap(now - 3600000, 50),  // Start
      snap(now - 2700000, 60),  // Up
      snap(now - 1800000, 40),  // Down
      snap(now - 900000, 55),   // Up again
      snap(now - 100, 55),      // Stable
    ];

    const trend = analyzeTrend(snapshots, 'Yes');
    expect(trend.currentPrice).toBe(55);
    expect(trend.volatility).toBeGreaterThan(0);
  });

  test('wide swings but ending at start price has moderate momentum', () => {
    const now = Date.now();
    const snapshots = [
      snap(now - 3600000, 50),
      snap(now - 2700000, 80),
      snap(now - 1800000, 20),
      snap(now - 900000, 70),
      snap(now - 100, 50),
    ];

    const trend = analyzeTrend(snapshots, 'Yes');
    expect(trend.currentPrice).toBe(50);
    // 1h change is 0 since it returned to 50
    if (trend.changePercent1h !== null) {
      expect(Math.abs(trend.changePercent1h)).toBeLessThanOrEqual(2);
    }
  });

  test('increasing amplitude oscillation', () => {
    const now = Date.now();
    // Oscillations get wilder
    const prices = [50, 52, 48, 55, 45, 60, 40, 65, 35, 70, 30, 75];
    const snapshots = makeSnapshots(prices, 300000, now);

    const trend = analyzeTrend(snapshots, 'Yes');
    expect(trend.volatility).toBeGreaterThan(10);
  });
});

// ─── Gaps in Price History ────────────────────────────────────────────────

describe('Gaps in Price History', () => {
  test('large time gap prevents 1h change calculation', () => {
    const now = Date.now();
    // Only snapshot from 2 days ago and now
    const snapshots = [
      snap(now - 172800000, 50),  // 48h ago
      snap(now - 100, 70),        // now
    ];

    const trend = analyzeTrend(snapshots, 'Yes');
    expect(trend.currentPrice).toBe(70);
    // 1h change should be null since closest snapshot is too far from 1h ago
    expect(trend.changePercent1h).toBeNull();
  });

  test('gap exactly at 6h window boundary', () => {
    const now = Date.now();
    // Snapshot exists near 6h ago but not at 1h
    const snapshots = [
      snap(now - 21600000, 50),  // 6h ago
      snap(now - 100, 65),       // now
    ];

    const trend = analyzeTrend(snapshots, 'Yes');
    expect(trend.currentPrice).toBe(65);
    // 6h change should be computable if within 20% tolerance
    // 21600000 * 0.2 = 4320000ms. Distance from 6h target = 100ms < 4320000ms
    expect(trend.changePercent6h).not.toBeNull();
  });

  test('intermittent gaps still calculate where data exists', () => {
    const now = Date.now();
    const snapshots = [
      snap(now - 86400000, 40),  // 24h ago
      // 18h gap
      snap(now - 21600000, 50),  // 6h ago
      // 5h gap
      snap(now - 3600000, 55),   // 1h ago
      snap(now - 1800000, 58),
      snap(now - 100, 60),
    ];

    const trend = analyzeTrend(snapshots, 'Yes');
    expect(trend.changePercent1h).not.toBeNull();
    expect(trend.changePercent6h).not.toBeNull();
    expect(trend.changePercent24h).not.toBeNull();
  });

  test('all snapshots at same timestamp', () => {
    const now = Date.now();
    const snapshots = [
      snap(now, 50),
      snap(now, 55),
      snap(now, 60),
    ];

    const trend = analyzeTrend(snapshots, 'Yes');
    expect(trend.currentPrice).toBe(60);
    expect(trend.dataPoints).toBe(3);
  });

  test('single snapshot returns no change data', () => {
    const now = Date.now();
    const snapshots = [snap(now - 100, 65)];

    const trend = analyzeTrend(snapshots, 'Yes');
    expect(trend.currentPrice).toBe(65);
    expect(trend.dataPoints).toBe(1);
    expect(trend.volatility).toBe(0);
  });
});

// ─── Gradual Trend Changes ────────────────────────────────────────────────

describe('Gradual Trend Change: trending_up → stable → trending_down', () => {
  test('trending_up phase with 1h change >= 2', () => {
    const now = Date.now();
    const snapshots = [
      snap(now - 3600000, 50),
      snap(now - 2700000, 51),
      snap(now - 1800000, 52),
      snap(now - 900000, 53),
      snap(now - 100, 54),
    ];

    const trend = analyzeTrend(snapshots, 'Yes');
    expect(trend.momentum).toBe('trending_up');
    expect(trend.changePercent1h).toBeGreaterThanOrEqual(2);
  });

  test('stable phase with 1h change near 0', () => {
    const now = Date.now();
    const snapshots = [
      snap(now - 3600000, 50),
      snap(now - 2700000, 50.2),
      snap(now - 1800000, 50.5),
      snap(now - 900000, 50.3),
      snap(now - 100, 50.1),
    ];

    const trend = analyzeTrend(snapshots, 'Yes');
    expect(trend.momentum).toBe('stable');
    if (trend.changePercent1h !== null) {
      expect(Math.abs(trend.changePercent1h)).toBeLessThan(2);
    }
  });

  test('trending_down phase with 1h change <= -2', () => {
    const now = Date.now();
    const snapshots = [
      snap(now - 3600000, 60),
      snap(now - 2700000, 59),
      snap(now - 1800000, 58),
      snap(now - 900000, 57),
      snap(now - 100, 56),
    ];

    const trend = analyzeTrend(snapshots, 'Yes');
    expect(trend.momentum).toBe('trending_down');
    expect(trend.changePercent1h).toBeLessThanOrEqual(-2);
  });

  test('surging_up phase with 1h change >= 5', () => {
    const now = Date.now();
    const snapshots = [
      snap(now - 3600000, 50),
      snap(now - 1800000, 53),
      snap(now - 100, 60),
    ];

    const trend = analyzeTrend(snapshots, 'Yes');
    expect(trend.momentum).toBe('surging_up');
    expect(trend.changePercent1h).toBeGreaterThanOrEqual(5);
  });

  test('surging_down phase with 1h change <= -5', () => {
    const now = Date.now();
    const snapshots = [
      snap(now - 3600000, 60),
      snap(now - 1800000, 57),
      snap(now - 100, 50),
    ];

    const trend = analyzeTrend(snapshots, 'Yes');
    expect(trend.momentum).toBe('surging_down');
    expect(trend.changePercent1h).toBeLessThanOrEqual(-5);
  });

  test('exactly at trending_up threshold (change = 2.0)', () => {
    const now = Date.now();
    const snapshots = [
      snap(now - 3600000, 50),
      snap(now - 100, 52),
    ];

    const trend = analyzeTrend(snapshots, 'Yes');
    expect(trend.momentum).toBe('trending_up');
  });

  test('exactly at surging_up threshold (change = 5.0)', () => {
    const now = Date.now();
    const snapshots = [
      snap(now - 3600000, 50),
      snap(now - 100, 55),
    ];

    const trend = analyzeTrend(snapshots, 'Yes');
    expect(trend.momentum).toBe('surging_up');
  });

  test('just below trending_up threshold (change = 1.9)', () => {
    const now = Date.now();
    const snapshots = [
      snap(now - 3600000, 50),
      snap(now - 100, 51.9),
    ];

    const trend = analyzeTrend(snapshots, 'Yes');
    expect(trend.momentum).toBe('stable');
  });
});

// ─── Flash Crash and Recovery ──────────────────────────────────────────────

describe('Flash Crash and Recovery', () => {
  test('flash crash to near-zero then full recovery', () => {
    const now = Date.now();
    const snapshots = [
      snap(now - 3600000, 70),
      snap(now - 2700000, 70),
      snap(now - 1800000, 5),    // Flash crash
      snap(now - 900000, 65),    // Recovery
      snap(now - 100, 70),       // Full recovery
    ];

    const trend = analyzeTrend(snapshots, 'Yes');
    expect(trend.currentPrice).toBe(70);
    // High volatility from flash crash
    expect(trend.volatility).toBeGreaterThan(10);
  });

  test('flash crash with no recovery', () => {
    const now = Date.now();
    const snapshots = [
      snap(now - 3600000, 70),
      snap(now - 2700000, 68),
      snap(now - 1800000, 65),
      snap(now - 900000, 10),  // Crash
      snap(now - 100, 12),     // Stays low
    ];

    const trend = analyzeTrend(snapshots, 'Yes');
    expect(trend.currentPrice).toBe(12);
    expect(trend.momentum).toBe('surging_down');
  });

  test('double flash crash (two dips)', () => {
    const now = Date.now();
    const snapshots = [
      snap(now - 3600000, 70),
      snap(now - 3000000, 20),  // First crash
      snap(now - 2400000, 65),  // Recovery
      snap(now - 1800000, 15),  // Second crash
      snap(now - 1200000, 60),  // Recovery
      snap(now - 600000, 62),
      snap(now - 100, 65),
    ];

    const trend = analyzeTrend(snapshots, 'Yes');
    expect(trend.currentPrice).toBe(65);
    expect(trend.volatility).toBeGreaterThan(10);
  });

  test('flash spike (opposite of crash)', () => {
    const now = Date.now();
    const snapshots = [
      snap(now - 3600000, 30),
      snap(now - 2700000, 30),
      snap(now - 1800000, 95),  // Flash spike
      snap(now - 900000, 35),   // Returns to normal
      snap(now - 100, 30),
    ];

    const trend = analyzeTrend(snapshots, 'Yes');
    expect(trend.currentPrice).toBe(30);
    expect(trend.volatility).toBeGreaterThan(10);
  });
});

// ─── Trending Then Sudden Spike ──────────────────────────────────────────

describe('Trending for N Periods Then Sudden Spike', () => {
  test('10 periods of gradual rise then spike', () => {
    const now = Date.now();
    // 10 gradual + 1 spike
    const prices = [50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 90];
    const snapshots = makeSnapshots(prices, 300000, now);

    const trend = analyzeTrend(snapshots, 'Yes');
    expect(trend.currentPrice).toBe(90);
    expect(trend.volatility).toBeGreaterThan(5);
  });

  test('gradual decline then sudden reversal upward', () => {
    const now = Date.now();
    const prices = [80, 78, 76, 74, 72, 70, 68, 66, 64, 62, 95];
    const snapshots = makeSnapshots(prices, 300000, now);

    const trend = analyzeTrend(snapshots, 'Yes');
    expect(trend.currentPrice).toBe(95);
  });

  test('flat then sudden drop', () => {
    const now = Date.now();
    const prices = [50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 10];
    const snapshots = makeSnapshots(prices, 300000, now);

    const trend = analyzeTrend(snapshots, 'Yes');
    expect(trend.currentPrice).toBe(10);
    expect(trend.volatility).toBeGreaterThan(5);
  });
});

// ─── Price History Boundary Cases ──────────────────────────────────────────

describe('Price History Boundary Cases', () => {
  test('price at 0%', () => {
    const now = Date.now();
    const snapshots = [
      snap(now - 3600000, 10),
      snap(now - 1800000, 5),
      snap(now - 100, 0),
    ];

    const trend = analyzeTrend(snapshots, 'Yes');
    expect(trend.currentPrice).toBe(0);
  });

  test('price at 100%', () => {
    const now = Date.now();
    const snapshots = [
      snap(now - 3600000, 90),
      snap(now - 1800000, 95),
      snap(now - 100, 100),
    ];

    const trend = analyzeTrend(snapshots, 'Yes');
    expect(trend.currentPrice).toBe(100);
  });

  test('price at exactly 50% (midpoint)', () => {
    const now = Date.now();
    const snapshots = [
      snap(now - 3600000, 50),
      snap(now - 1800000, 50),
      snap(now - 100, 50),
    ];

    const trend = analyzeTrend(snapshots, 'Yes');
    expect(trend.currentPrice).toBe(50);
    expect(trend.volatility).toBe(0);
    expect(trend.momentum).toBe('stable');
  });

  test('no snapshots returns zero defaults', () => {
    const trend = analyzeTrend([], 'Yes');
    expect(trend.currentPrice).toBe(0);
    expect(trend.changePercent1h).toBeNull();
    expect(trend.changePercent6h).toBeNull();
    expect(trend.changePercent24h).toBeNull();
    expect(trend.momentum).toBe('stable');
    expect(trend.volatility).toBe(0);
    expect(trend.dataPoints).toBe(0);
  });

  test('snapshots for wrong outcome returns zero defaults', () => {
    const now = Date.now();
    const snapshots = [
      { timestamp: now - 3600000, prices: { No: 50 } },
      { timestamp: now - 100, prices: { No: 60 } },
    ];

    const trend = analyzeTrend(snapshots, 'Yes');
    expect(trend.currentPrice).toBe(0);
    expect(trend.dataPoints).toBe(0);
  });

  test('very small price increments (0.01 steps)', () => {
    const now = Date.now();
    const prices = Array.from({ length: 12 }, (_, i) => 50 + i * 0.01);
    const snapshots = makeSnapshots(prices, 300000, now);

    const trend = analyzeTrend(snapshots, 'Yes');
    expect(trend.currentPrice).toBeCloseTo(50.11, 2);
    expect(trend.volatility).toBeLessThan(1);
  });

  test('maximum 12-point window for volatility calculation', () => {
    const now = Date.now();
    // 20 data points - volatility uses last 12
    const prices = [
      10, 90, 10, 90, 10, 90, 10, 90, // First 8 (wild)
      50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, // Last 12 (stable)
    ];
    const snapshots = makeSnapshots(prices, 300000, now);

    const trend = analyzeTrend(snapshots, 'Yes');
    // Volatility only uses last 12 which are all 50 → volatility = 0
    expect(trend.volatility).toBe(0);
  });

  test('time change windows: 1h, 6h, 24h correctly calculated', () => {
    const now = Date.now();
    const snapshots = [
      snap(now - 86400000, 30),  // 24h ago
      snap(now - 21600000, 40),  // 6h ago
      snap(now - 3600000, 50),   // 1h ago
      snap(now - 100, 60),       // now
    ];

    const trend = analyzeTrend(snapshots, 'Yes');
    expect(trend.changePercent1h).toBe(10);   // 60 - 50
    expect(trend.changePercent6h).toBe(20);   // 60 - 40
    expect(trend.changePercent24h).toBe(30);  // 60 - 30
  });
});

// ─── Record Price Snapshot Edge Cases ──────────────────────────────────────

describe('recordPriceSnapshot Edge Cases', () => {
  test('respects maxSnapshots trimming', () => {
    const history: Record<string, PriceSnapshot[]> = {};
    const market = {
      condition_id: 'm1',
      question: 'Test?',
      outcomes: ['Yes', 'No'],
      tokens: [
        { token_id: 't1', outcome: 'Yes', price: 0.5 },
        { token_id: 't2', outcome: 'No', price: 0.5 },
      ],
      active: true,
      closed: false,
    };

    // Record more than maxSnapshots
    for (let i = 0; i < 10; i++) {
      recordPriceSnapshot(history, 'm1', market, 5);
    }

    expect(history['m1'].length).toBe(5);
  });

  test('handles market with no tokens', () => {
    const history: Record<string, PriceSnapshot[]> = {};
    const market = {
      condition_id: 'm1',
      question: 'Test?',
      outcomes: ['Yes', 'No'],
      tokens: [],
      active: true,
      closed: false,
    };

    recordPriceSnapshot(history, 'm1', market);
    expect(history['m1'].length).toBe(1);
    expect(Object.keys(history['m1'][0].prices)).toHaveLength(0);
  });

  test('records multiple outcomes correctly', () => {
    const history: Record<string, PriceSnapshot[]> = {};
    const market = {
      condition_id: 'm1',
      question: 'Test?',
      outcomes: ['A', 'B', 'C'],
      tokens: [
        { token_id: 't1', outcome: 'A', price: 0.4 },
        { token_id: 't2', outcome: 'B', price: 0.35 },
        { token_id: 't3', outcome: 'C', price: 0.25 },
      ],
      active: true,
      closed: false,
    };

    recordPriceSnapshot(history, 'm1', market);
    expect(history['m1'][0].prices['A']).toBeCloseTo(40, 1);
    expect(history['m1'][0].prices['B']).toBeCloseTo(35, 1);
    expect(history['m1'][0].prices['C']).toBeCloseTo(25, 1);
  });
});
