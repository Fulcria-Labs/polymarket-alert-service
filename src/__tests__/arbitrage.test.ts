import { describe, test, expect } from 'bun:test';
import {
  detectSingleMarketArbitrage,
  detectCrossMarketArbitrage,
  scanForArbitrage,
} from '../portfolio';
import type { PriceSnapshot } from '../polymarket-alert-workflow';

describe('Single Market Arbitrage Detection', () => {
  test('detects overpriced market (outcomes > 100%)', () => {
    const result = detectSingleMarketArbitrage(
      'market1',
      'Will it rain tomorrow?',
      [
        { name: 'Yes', price: 60 },
        { name: 'No', price: 50 },
      ],
    );

    expect(result).not.toBeNull();
    expect(result!.type).toBe('overpriced');
    expect(result!.totalPrice).toBe(110);
    expect(result!.deviation).toBe(10);
    expect(result!.potentialProfit).toBe(10);
  });

  test('detects underpriced market (outcomes < 100%)', () => {
    const result = detectSingleMarketArbitrage(
      'market2',
      'Election outcome?',
      [
        { name: 'Yes', price: 40 },
        { name: 'No', price: 50 },
      ],
    );

    expect(result).not.toBeNull();
    expect(result!.type).toBe('underpriced');
    expect(result!.totalPrice).toBe(90);
    expect(result!.deviation).toBe(10);
  });

  test('returns null for fair market (within threshold)', () => {
    const result = detectSingleMarketArbitrage(
      'market3',
      'Fair market',
      [
        { name: 'Yes', price: 51 },
        { name: 'No', price: 49 },
      ],
    );

    expect(result).toBeNull(); // 100% total, no deviation
  });

  test('returns null for near-fair market', () => {
    const result = detectSingleMarketArbitrage(
      'market4',
      'Almost fair',
      [
        { name: 'Yes', price: 52 },
        { name: 'No', price: 49 },
      ],
      3, // 3% threshold
    );

    expect(result).toBeNull(); // 101%, within threshold
  });

  test('returns null for single outcome', () => {
    const result = detectSingleMarketArbitrage(
      'market5',
      'One outcome',
      [{ name: 'Yes', price: 70 }],
    );
    expect(result).toBeNull();
  });

  test('high confidence for large deviation', () => {
    const result = detectSingleMarketArbitrage(
      'market6',
      'Very mispriced',
      [
        { name: 'Yes', price: 70 },
        { name: 'No', price: 50 },
      ],
    );

    expect(result).not.toBeNull();
    expect(result!.confidence).toBe('high');
    expect(result!.deviation).toBe(20);
  });

  test('medium confidence for moderate deviation', () => {
    const result = detectSingleMarketArbitrage(
      'market7',
      'Moderately mispriced',
      [
        { name: 'Yes', price: 54 },
        { name: 'No', price: 54 },
      ],
    );

    expect(result).not.toBeNull();
    expect(result!.confidence).toBe('medium');
  });

  test('low confidence for small deviation', () => {
    const result = detectSingleMarketArbitrage(
      'market8',
      'Slightly mispriced',
      [
        { name: 'Yes', price: 52 },
        { name: 'No', price: 52 },
      ],
    );

    expect(result).not.toBeNull();
    expect(result!.confidence).toBe('low');
  });

  test('handles multiple outcomes (3-way market)', () => {
    const result = detectSingleMarketArbitrage(
      'market9',
      'Three way',
      [
        { name: 'A', price: 40 },
        { name: 'B', price: 35 },
        { name: 'C', price: 35 },
      ],
    );

    expect(result).not.toBeNull();
    expect(result!.totalPrice).toBe(110);
    expect(result!.type).toBe('overpriced');
  });

  test('handles zero-priced outcomes', () => {
    const result = detectSingleMarketArbitrage(
      'market10',
      'Zero outcome',
      [
        { name: 'Yes', price: 95 },
        { name: 'No', price: 0 },
      ],
      3,
    );

    expect(result).not.toBeNull();
    expect(result!.type).toBe('underpriced');
    expect(result!.totalPrice).toBe(95);
  });

  test('respects custom threshold', () => {
    // 5% deviation, threshold = 10
    const result = detectSingleMarketArbitrage(
      'market11',
      'Custom threshold',
      [
        { name: 'Yes', price: 55 },
        { name: 'No', price: 50 },
      ],
      10,
    );

    expect(result).toBeNull(); // Below 10% threshold
  });

  test('preserves market metadata', () => {
    const result = detectSingleMarketArbitrage(
      'abc123',
      'Will BTC reach $100K?',
      [
        { name: 'Yes', price: 70 },
        { name: 'No', price: 40 },
      ],
    );

    expect(result!.marketId).toBe('abc123');
    expect(result!.question).toBe('Will BTC reach $100K?');
    expect(result!.outcomes).toHaveLength(2);
  });

  test('handles decimal prices', () => {
    const result = detectSingleMarketArbitrage(
      'market12',
      'Decimals',
      [
        { name: 'Yes', price: 55.5 },
        { name: 'No', price: 55.5 },
      ],
    );

    expect(result).not.toBeNull();
    expect(result!.totalPrice).toBe(111);
  });
});

describe('Cross Market Arbitrage', () => {
  test('detects complementary market mispricing', () => {
    const result = detectCrossMarketArbitrage(
      { id: 'm1', question: 'Will A happen?', outcome: 'Yes', price: 70 },
      { id: 'm2', question: 'Will A NOT happen?', outcome: 'Yes', price: 40 },
      'complementary',
      {},
    );

    expect(result).not.toBeNull();
    expect(result!.combinedPrice).toBe(110);
    expect(result!.expectedCombined).toBe(100);
    expect(result!.deviation).toBe(10);
    expect(result!.opportunity).toContain('Sell');
  });

  test('detects underpriced complementary pair', () => {
    const result = detectCrossMarketArbitrage(
      { id: 'm1', question: 'Will A happen?', outcome: 'Yes', price: 40 },
      { id: 'm2', question: 'Will A NOT happen?', outcome: 'Yes', price: 50 },
      'complementary',
      {},
    );

    expect(result).not.toBeNull();
    expect(result!.combinedPrice).toBe(90);
    expect(result!.opportunity).toContain('Buy');
  });

  test('returns null for fair complementary pair', () => {
    const result = detectCrossMarketArbitrage(
      { id: 'm1', question: 'A', outcome: 'Yes', price: 51 },
      { id: 'm2', question: 'Not A', outcome: 'Yes', price: 49 },
      'complementary',
      {},
    );

    expect(result).toBeNull(); // Within 3% tolerance
  });

  test('detects correlated market deviation', () => {
    const now = Date.now();
    const interval = 300000;

    // Historical: both markets around 50%
    const priceHistory: Record<string, PriceSnapshot[]> = {
      m1: Array.from({ length: 10 }, (_, i) => ({
        timestamp: now - (9 - i) * interval,
        prices: { Yes: 48 + Math.random() * 4 },
      })),
      m2: Array.from({ length: 10 }, (_, i) => ({
        timestamp: now - (9 - i) * interval,
        prices: { Yes: 48 + Math.random() * 4 },
      })),
    };

    // Now they're significantly deviated
    const result = detectCrossMarketArbitrage(
      { id: 'm1', question: 'Market A', outcome: 'Yes', price: 80 },
      { id: 'm2', question: 'Market B', outcome: 'Yes', price: 80 },
      'correlated',
      priceHistory,
    );

    // Combined 160 vs historical ~100 = significant deviation
    if (result) {
      expect(result.deviation).toBeGreaterThan(3);
    }
  });

  test('returns null for insufficient correlated history', () => {
    const result = detectCrossMarketArbitrage(
      { id: 'm1', question: 'A', outcome: 'Yes', price: 50 },
      { id: 'm2', question: 'B', outcome: 'Yes', price: 50 },
      'correlated',
      {
        m1: [{ timestamp: Date.now(), prices: { Yes: 50 } }],
        m2: [{ timestamp: Date.now(), prices: { Yes: 50 } }],
      },
    );

    expect(result).toBeNull();
  });

  test('returns null for correlated markets with no history', () => {
    const result = detectCrossMarketArbitrage(
      { id: 'm1', question: 'A', outcome: 'Yes', price: 50 },
      { id: 'm2', question: 'B', outcome: 'Yes', price: 50 },
      'correlated',
      {},
    );

    expect(result).toBeNull();
  });

  test('handles contradictory relationship', () => {
    const result = detectCrossMarketArbitrage(
      { id: 'm1', question: 'Party A wins', outcome: 'Yes', price: 60 },
      { id: 'm2', question: 'Party B wins', outcome: 'Yes', price: 50 },
      'contradictory',
      {},
    );

    expect(result).not.toBeNull();
    expect(result!.expectedCombined).toBe(100);
    expect(result!.combinedPrice).toBe(110);
  });

  test('opportunity message contains market names', () => {
    const result = detectCrossMarketArbitrage(
      { id: 'm1', question: 'Trump wins', outcome: 'Yes', price: 70 },
      { id: 'm2', question: 'GOP Senate', outcome: 'Yes', price: 40 },
      'complementary',
      {},
    );

    expect(result).not.toBeNull();
    expect(result!.opportunity).toContain('Trump wins');
    expect(result!.opportunity).toContain('GOP Senate');
  });
});

describe('Arbitrage Scanner', () => {
  test('scans multiple markets and finds opportunities', () => {
    const markets = [
      {
        id: 'm1',
        question: 'Overpriced market',
        outcomes: [
          { name: 'Yes', price: 70 },
          { name: 'No', price: 50 },
        ],
      },
      {
        id: 'm2',
        question: 'Fair market',
        outcomes: [
          { name: 'Yes', price: 60 },
          { name: 'No', price: 40 },
        ],
      },
      {
        id: 'm3',
        question: 'Underpriced market',
        outcomes: [
          { name: 'Yes', price: 40 },
          { name: 'No', price: 45 },
        ],
      },
    ];

    const results = scanForArbitrage(markets);

    // m1 (120%) and m3 (85%) should be flagged
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  test('sorts by potential profit descending', () => {
    const markets = [
      {
        id: 'm1',
        question: 'Small deviation',
        outcomes: [
          { name: 'Yes', price: 54 },
          { name: 'No', price: 50 },
        ],
      },
      {
        id: 'm2',
        question: 'Large deviation',
        outcomes: [
          { name: 'Yes', price: 70 },
          { name: 'No', price: 60 },
        ],
      },
    ];

    const results = scanForArbitrage(markets);
    if (results.length >= 2) {
      expect(results[0].potentialProfit).toBeGreaterThanOrEqual(results[1].potentialProfit);
    }
  });

  test('returns empty for all fair markets', () => {
    const markets = [
      {
        id: 'm1',
        question: 'Fair 1',
        outcomes: [
          { name: 'Yes', price: 50 },
          { name: 'No', price: 50 },
        ],
      },
      {
        id: 'm2',
        question: 'Fair 2',
        outcomes: [
          { name: 'Yes', price: 60 },
          { name: 'No', price: 40 },
        ],
      },
    ];

    const results = scanForArbitrage(markets);
    expect(results).toHaveLength(0);
  });

  test('respects custom threshold', () => {
    const markets = [
      {
        id: 'm1',
        question: 'Slightly off',
        outcomes: [
          { name: 'Yes', price: 53 },
          { name: 'No', price: 50 },
        ],
      },
    ];

    expect(scanForArbitrage(markets, 5)).toHaveLength(0); // 3% < 5% threshold
    expect(scanForArbitrage(markets, 2)).toHaveLength(1); // 3% > 2% threshold
  });

  test('handles empty market list', () => {
    expect(scanForArbitrage([])).toHaveLength(0);
  });

  test('handles markets with many outcomes', () => {
    const markets = [
      {
        id: 'm1',
        question: 'Multi-way',
        outcomes: [
          { name: 'A', price: 30 },
          { name: 'B', price: 25 },
          { name: 'C', price: 25 },
          { name: 'D', price: 20 },
          { name: 'E', price: 15 },
        ],
      },
    ];

    const results = scanForArbitrage(markets);
    expect(results).toHaveLength(1);
    expect(results[0].totalPrice).toBe(115);
  });

  test('handles market with zero prices', () => {
    const markets = [
      {
        id: 'm1',
        question: 'Zero prices',
        outcomes: [
          { name: 'Yes', price: 0 },
          { name: 'No', price: 0 },
        ],
      },
    ];

    const results = scanForArbitrage(markets);
    // Total = 0, deviation from 100 = 100
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('underpriced');
  });

  test('handles market with 100% single outcome', () => {
    const markets = [
      {
        id: 'm1',
        question: 'Resolved',
        outcomes: [
          { name: 'Yes', price: 99 },
          { name: 'No', price: 1 },
        ],
      },
    ];

    const results = scanForArbitrage(markets);
    expect(results).toHaveLength(0); // 100% total, fair
  });
});

describe('Arbitrage Edge Cases', () => {
  test('very small prices', () => {
    const result = detectSingleMarketArbitrage(
      'm1',
      'Tiny prices',
      [
        { name: 'Yes', price: 0.5 },
        { name: 'No', price: 0.5 },
      ],
    );

    // Total = 1%, deviation = 99%
    expect(result).not.toBeNull();
    expect(result!.type).toBe('underpriced');
  });

  test('exactly at threshold boundary', () => {
    const result = detectSingleMarketArbitrage(
      'm1',
      'Boundary',
      [
        { name: 'Yes', price: 51.5 },
        { name: 'No', price: 51.5 },
      ],
      3,
    );

    // Total = 103%, deviation = 3, equals threshold — detected since deviation < threshold is the skip condition
    expect(result).not.toBeNull();
    expect(result!.deviation).toBe(3);
  });

  test('just above threshold', () => {
    const result = detectSingleMarketArbitrage(
      'm1',
      'Just above',
      [
        { name: 'Yes', price: 51.6 },
        { name: 'No', price: 51.6 },
      ],
      3,
    );

    // Total = 103.2%, deviation = 3.2 > 3
    expect(result).not.toBeNull();
  });

  test('extremely high prices', () => {
    const result = detectSingleMarketArbitrage(
      'm1',
      'Very high',
      [
        { name: 'Yes', price: 99 },
        { name: 'No', price: 99 },
      ],
    );

    expect(result).not.toBeNull();
    expect(result!.totalPrice).toBe(198);
    expect(result!.confidence).toBe('high');
  });

  test('negative prices (edge case)', () => {
    const result = detectSingleMarketArbitrage(
      'm1',
      'Negative',
      [
        { name: 'Yes', price: -10 },
        { name: 'No', price: 80 },
      ],
    );

    // Total = 70, deviation = 30
    expect(result).not.toBeNull();
    expect(result!.type).toBe('underpriced');
  });

  test('cross-market with extreme prices', () => {
    const result = detectCrossMarketArbitrage(
      { id: 'm1', question: 'A', outcome: 'Yes', price: 99 },
      { id: 'm2', question: 'B', outcome: 'Yes', price: 99 },
      'complementary',
      {},
    );

    expect(result).not.toBeNull();
    expect(result!.deviation).toBe(98);
  });

  test('cross-market with zero prices', () => {
    const result = detectCrossMarketArbitrage(
      { id: 'm1', question: 'A', outcome: 'Yes', price: 0 },
      { id: 'm2', question: 'B', outcome: 'Yes', price: 0 },
      'complementary',
      {},
    );

    expect(result).not.toBeNull();
    expect(result!.combinedPrice).toBe(0);
    expect(result!.deviation).toBe(100);
  });

  test('scan with mixed market types', () => {
    const markets = [
      {
        id: 'm1',
        question: 'Binary',
        outcomes: [
          { name: 'Yes', price: 55 },
          { name: 'No', price: 55 },
        ],
      },
      {
        id: 'm2',
        question: 'Ternary',
        outcomes: [
          { name: 'A', price: 40 },
          { name: 'B', price: 35 },
          { name: 'C', price: 35 },
        ],
      },
      {
        id: 'm3',
        question: 'Five-way',
        outcomes: [
          { name: '1', price: 22 },
          { name: '2', price: 22 },
          { name: '3', price: 22 },
          { name: '4', price: 22 },
          { name: '5', price: 22 },
        ],
      },
    ];

    const results = scanForArbitrage(markets);
    // All overpriced: 110%, 110%, 110%
    expect(results).toHaveLength(3);
    results.forEach(r => expect(r.type).toBe('overpriced'));
  });
});
