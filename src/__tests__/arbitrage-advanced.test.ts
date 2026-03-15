/**
 * Arbitrage Advanced Tests
 *
 * Covers binary market mispricing (Yes+No != 100%), multi-outcome market
 * mispricing, cascading arbitrage, transaction cost considerations,
 * sub-threshold mispricings, correctly priced markets, exact 50/50 edge cases,
 * and cross-market arbitrage with correlated history.
 */
import { describe, test, expect } from 'bun:test';
import {
  detectSingleMarketArbitrage,
  detectCrossMarketArbitrage,
  scanForArbitrage,
} from '../portfolio';
import type { ArbitrageOpportunity, CrossMarketArbitrage } from '../portfolio';
import type { PriceSnapshot } from '../polymarket-alert-workflow';

// Helper to create price history
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

// ─── Binary Market: Yes + No Significantly != 100% ────────────────────────

describe('Binary Market Mispricing (Yes + No != 100%)', () => {
  test('significantly overpriced: 65% + 55% = 120%', () => {
    const result = detectSingleMarketArbitrage(
      'binary1',
      'Will BTC hit $200K in 2026?',
      [
        { name: 'Yes', price: 65 },
        { name: 'No', price: 55 },
      ],
    );

    expect(result).not.toBeNull();
    expect(result!.type).toBe('overpriced');
    expect(result!.totalPrice).toBe(120);
    expect(result!.deviation).toBe(20);
    expect(result!.potentialProfit).toBe(20);
    expect(result!.confidence).toBe('high');
  });

  test('significantly underpriced: 30% + 40% = 70%', () => {
    const result = detectSingleMarketArbitrage(
      'binary2',
      'Will ETH flip BTC?',
      [
        { name: 'Yes', price: 30 },
        { name: 'No', price: 40 },
      ],
    );

    expect(result).not.toBeNull();
    expect(result!.type).toBe('underpriced');
    expect(result!.totalPrice).toBe(70);
    expect(result!.deviation).toBe(30);
    expect(result!.confidence).toBe('high');
  });

  test('slight overpricing: 52% + 51% = 103%', () => {
    const result = detectSingleMarketArbitrage(
      'binary3',
      'Slight overpricing',
      [
        { name: 'Yes', price: 52 },
        { name: 'No', price: 51 },
      ],
    );

    expect(result).not.toBeNull();
    expect(result!.type).toBe('overpriced');
    expect(result!.deviation).toBe(3);
    expect(result!.confidence).toBe('low');
  });

  test('slight underpricing: 48% + 49% = 97%', () => {
    const result = detectSingleMarketArbitrage(
      'binary4',
      'Slight underpricing',
      [
        { name: 'Yes', price: 48 },
        { name: 'No', price: 49 },
      ],
    );

    expect(result).not.toBeNull();
    expect(result!.type).toBe('underpriced');
    expect(result!.deviation).toBe(3);
    expect(result!.confidence).toBe('low');
  });

  test('extreme overpricing: 90% + 85% = 175%', () => {
    const result = detectSingleMarketArbitrage(
      'binary5',
      'Extreme overpricing',
      [
        { name: 'Yes', price: 90 },
        { name: 'No', price: 85 },
      ],
    );

    expect(result).not.toBeNull();
    expect(result!.type).toBe('overpriced');
    expect(result!.totalPrice).toBe(175);
    expect(result!.deviation).toBe(75);
    expect(result!.confidence).toBe('high');
  });

  test('extreme underpricing: 5% + 5% = 10%', () => {
    const result = detectSingleMarketArbitrage(
      'binary6',
      'Extreme underpricing',
      [
        { name: 'Yes', price: 5 },
        { name: 'No', price: 5 },
      ],
    );

    expect(result).not.toBeNull();
    expect(result!.type).toBe('underpriced');
    expect(result!.totalPrice).toBe(10);
    expect(result!.deviation).toBe(90);
  });
});

// ─── Multi-Outcome Market Mispricing ──────────────────────────────────────

describe('Multi-Outcome Market Mispricing', () => {
  test('3-outcome market overpriced: 40 + 35 + 35 = 110%', () => {
    const result = detectSingleMarketArbitrage(
      'multi1',
      'Who wins the election?',
      [
        { name: 'Candidate A', price: 40 },
        { name: 'Candidate B', price: 35 },
        { name: 'Candidate C', price: 35 },
      ],
    );

    expect(result).not.toBeNull();
    expect(result!.totalPrice).toBe(110);
    expect(result!.type).toBe('overpriced');
  });

  test('4-outcome market underpriced: 20 + 20 + 20 + 20 = 80%', () => {
    const result = detectSingleMarketArbitrage(
      'multi2',
      'Which quarter will rates be cut?',
      [
        { name: 'Q1', price: 20 },
        { name: 'Q2', price: 20 },
        { name: 'Q3', price: 20 },
        { name: 'Q4', price: 20 },
      ],
    );

    expect(result).not.toBeNull();
    expect(result!.totalPrice).toBe(80);
    expect(result!.type).toBe('underpriced');
    expect(result!.deviation).toBe(20);
  });

  test('5-outcome market exactly at 100%', () => {
    const result = detectSingleMarketArbitrage(
      'multi3',
      'Fair five-way market',
      [
        { name: 'A', price: 25 },
        { name: 'B', price: 20 },
        { name: 'C', price: 20 },
        { name: 'D', price: 20 },
        { name: 'E', price: 15 },
      ],
    );

    expect(result).toBeNull();
  });

  test('6-outcome market barely overpriced: sum = 103.5%', () => {
    const result = detectSingleMarketArbitrage(
      'multi4',
      'Which team wins?',
      [
        { name: 'Team1', price: 20 },
        { name: 'Team2', price: 18 },
        { name: 'Team3', price: 17 },
        { name: 'Team4', price: 16.5 },
        { name: 'Team5', price: 16 },
        { name: 'Team6', price: 16 },
      ],
    );

    expect(result).not.toBeNull();
    expect(result!.totalPrice).toBe(103.5);
    expect(result!.confidence).toBe('low');
  });

  test('10-outcome market with significant mispricing', () => {
    const outcomes = Array.from({ length: 10 }, (_, i) => ({
      name: `Option${i + 1}`,
      price: 15,
    }));
    // Sum = 150%

    const result = detectSingleMarketArbitrage(
      'multi5',
      'Ten-way race',
      outcomes,
    );

    expect(result).not.toBeNull();
    expect(result!.totalPrice).toBe(150);
    expect(result!.type).toBe('overpriced');
    expect(result!.confidence).toBe('high');
  });

  test('multi-outcome with one dominant price', () => {
    const result = detectSingleMarketArbitrage(
      'multi6',
      'Heavy favorite',
      [
        { name: 'Favorite', price: 85 },
        { name: 'Underdog1', price: 10 },
        { name: 'Underdog2', price: 5 },
        { name: 'Underdog3', price: 5 },
      ],
    );

    // Sum = 105, deviation = 5 → medium confidence
    expect(result).not.toBeNull();
    expect(result!.totalPrice).toBe(105);
    expect(result!.confidence).toBe('medium');
  });
});

// ─── Cascading Arbitrage Opportunities ───────────────────────────────────

describe('Cascading Arbitrage Opportunities', () => {
  test('scan finds multiple arbitrage opportunities across related markets', () => {
    const markets = [
      {
        id: 'pres',
        question: 'Who wins presidency?',
        outcomes: [
          { name: 'Yes', price: 60 },
          { name: 'No', price: 55 }, // 115%
        ],
      },
      {
        id: 'senate',
        question: 'Senate majority?',
        outcomes: [
          { name: 'Yes', price: 55 },
          { name: 'No', price: 55 }, // 110%
        ],
      },
      {
        id: 'house',
        question: 'House majority?',
        outcomes: [
          { name: 'Yes', price: 45 },
          { name: 'No', price: 45 }, // 90%
        ],
      },
    ];

    const results = scanForArbitrage(markets);
    expect(results.length).toBe(3);
    // Should be sorted by profit
    expect(results[0].potentialProfit).toBeGreaterThanOrEqual(results[1].potentialProfit);
    expect(results[1].potentialProfit).toBeGreaterThanOrEqual(results[2].potentialProfit);
  });

  test('scan with mixed fair and unfair markets', () => {
    const markets = [
      {
        id: 'fair1',
        question: 'Fair market 1',
        outcomes: [{ name: 'Yes', price: 50 }, { name: 'No', price: 50 }],
      },
      {
        id: 'unfair1',
        question: 'Overpriced market',
        outcomes: [{ name: 'Yes', price: 70 }, { name: 'No', price: 60 }],
      },
      {
        id: 'fair2',
        question: 'Fair market 2',
        outcomes: [{ name: 'Yes', price: 60 }, { name: 'No', price: 40 }],
      },
      {
        id: 'unfair2',
        question: 'Underpriced market',
        outcomes: [{ name: 'Yes', price: 30 }, { name: 'No', price: 30 }],
      },
    ];

    const results = scanForArbitrage(markets);
    expect(results.length).toBe(2);
    expect(results.find(r => r.marketId === 'unfair1')).toBeDefined();
    expect(results.find(r => r.marketId === 'unfair2')).toBeDefined();
  });

  test('scan with custom threshold filters out small opportunities', () => {
    const markets = [
      {
        id: 'small',
        question: 'Small mispricing',
        outcomes: [{ name: 'Yes', price: 52 }, { name: 'No', price: 52 }], // 104%
      },
      {
        id: 'large',
        question: 'Large mispricing',
        outcomes: [{ name: 'Yes', price: 70 }, { name: 'No', price: 60 }], // 130%
      },
    ];

    const withLowThreshold = scanForArbitrage(markets, 3);
    expect(withLowThreshold.length).toBe(2);

    const withHighThreshold = scanForArbitrage(markets, 10);
    expect(withHighThreshold.length).toBe(1);
    expect(withHighThreshold[0].marketId).toBe('large');
  });
});

// ─── Transaction Cost Considerations ─────────────────────────────────────

describe('Arbitrage with Transaction Costs', () => {
  test('mispricing exactly equals typical transaction cost (3%)', () => {
    const result = detectSingleMarketArbitrage(
      'txcost1',
      'At transaction cost boundary',
      [
        { name: 'Yes', price: 51.5 },
        { name: 'No', price: 51.5 },
      ],
      3, // Threshold matches typical tx cost
    );

    // Deviation = 3%, which equals threshold → should be detected
    // (the code uses `< threshold` to skip, not `<=`)
    expect(result).not.toBeNull();
    expect(result!.deviation).toBe(3);
  });

  test('mispricing below transaction cost threshold is filtered', () => {
    const result = detectSingleMarketArbitrage(
      'txcost2',
      'Below transaction cost',
      [
        { name: 'Yes', price: 51 },
        { name: 'No', price: 50 },
      ],
      3,
    );

    // 101% total, 1% deviation < 3% threshold
    expect(result).toBeNull();
  });

  test('profitable after 5% transaction cost', () => {
    const result = detectSingleMarketArbitrage(
      'txcost3',
      'Profitable after costs',
      [
        { name: 'Yes', price: 60 },
        { name: 'No', price: 55 },
      ],
      5,
    );

    // 115% total, 15% deviation > 5% threshold → profitable
    expect(result).not.toBeNull();
    expect(result!.potentialProfit).toBe(15);
    expect(result!.confidence).toBe('high');
  });

  test('zero threshold catches all mispricings', () => {
    const result = detectSingleMarketArbitrage(
      'txcost4',
      'Any mispricing',
      [
        { name: 'Yes', price: 50.1 },
        { name: 'No', price: 50 },
      ],
      0,
    );

    // 100.1% total, 0.1% deviation > 0%
    expect(result).not.toBeNull();
  });
});

// ─── Very Small Mispricings ──────────────────────────────────────────────

describe('Very Small Mispricings (Below Transaction Cost)', () => {
  test('0.1% deviation with default threshold is filtered', () => {
    const result = detectSingleMarketArbitrage(
      'small1',
      'Tiny mispricing',
      [
        { name: 'Yes', price: 50.05 },
        { name: 'No', price: 50.05 },
      ],
    );

    // 100.1% total, 0.1% deviation < 3% default threshold
    expect(result).toBeNull();
  });

  test('1% deviation with default threshold is filtered', () => {
    const result = detectSingleMarketArbitrage(
      'small2',
      'Small mispricing',
      [
        { name: 'Yes', price: 50.5 },
        { name: 'No', price: 50.5 },
      ],
    );

    // 101% total, 1% deviation < 3% default threshold
    expect(result).toBeNull();
  });

  test('2.99% deviation with 3% threshold is filtered', () => {
    const result = detectSingleMarketArbitrage(
      'small3',
      'Just below threshold',
      [
        { name: 'Yes', price: 51.495 },
        { name: 'No', price: 51.495 },
      ],
      3,
    );

    // 102.99%, deviation = 2.99 < 3
    expect(result).toBeNull();
  });

  test('fractional cent mispricings with low threshold', () => {
    const result = detectSingleMarketArbitrage(
      'small4',
      'Fractional cent',
      [
        { name: 'Yes', price: 50.001 },
        { name: 'No', price: 50.001 },
      ],
      0.001,
    );

    // 100.002%, deviation = 0.002 > 0.001
    expect(result).not.toBeNull();
  });
});

// ─── Correctly Priced Markets ────────────────────────────────────────────

describe('No Arbitrage Opportunity (Correctly Priced)', () => {
  test('perfect 50/50 market', () => {
    const result = detectSingleMarketArbitrage(
      'correct1',
      'Perfect split',
      [
        { name: 'Yes', price: 50 },
        { name: 'No', price: 50 },
      ],
    );

    expect(result).toBeNull();
  });

  test('60/40 market sums to 100', () => {
    const result = detectSingleMarketArbitrage(
      'correct2',
      'Sixty-forty',
      [
        { name: 'Yes', price: 60 },
        { name: 'No', price: 40 },
      ],
    );

    expect(result).toBeNull();
  });

  test('99/1 market sums to 100', () => {
    const result = detectSingleMarketArbitrage(
      'correct3',
      'Almost certain',
      [
        { name: 'Yes', price: 99 },
        { name: 'No', price: 1 },
      ],
    );

    expect(result).toBeNull();
  });

  test('3-way market sums to exactly 100', () => {
    const result = detectSingleMarketArbitrage(
      'correct4',
      'Three way fair',
      [
        { name: 'A', price: 50 },
        { name: 'B', price: 30 },
        { name: 'C', price: 20 },
      ],
    );

    expect(result).toBeNull();
  });

  test('4-way market sums to exactly 100', () => {
    const result = detectSingleMarketArbitrage(
      'correct5',
      'Four way fair',
      [
        { name: 'Q1', price: 25 },
        { name: 'Q2', price: 25 },
        { name: 'Q3', price: 25 },
        { name: 'Q4', price: 25 },
      ],
    );

    expect(result).toBeNull();
  });

  test('within 1% tolerance is still fair with 3% threshold', () => {
    const result = detectSingleMarketArbitrage(
      'correct6',
      'Within tolerance',
      [
        { name: 'Yes', price: 50.5 },
        { name: 'No', price: 50.5 },
      ],
      3,
    );

    // 101%, deviation = 1% < 3%
    expect(result).toBeNull();
  });
});

// ─── Edge Case: Market at Exactly 50/50 ──────────────────────────────────

describe('Market at Exactly 50/50', () => {
  test('50/50 binary is perfectly priced', () => {
    const result = detectSingleMarketArbitrage(
      'fifty1',
      'Coin flip market',
      [
        { name: 'Yes', price: 50 },
        { name: 'No', price: 50 },
      ],
    );

    expect(result).toBeNull();
  });

  test('50/50 cross-market complementary is perfectly priced', () => {
    const result = detectCrossMarketArbitrage(
      { id: 'm1', question: 'Event A?', outcome: 'Yes', price: 50 },
      { id: 'm2', question: 'Not Event A?', outcome: 'Yes', price: 50 },
      'complementary',
      {},
    );

    expect(result).toBeNull(); // Combined = 100, expected = 100, deviation = 0
  });

  test('50/50 cross-market contradictory is perfectly priced', () => {
    const result = detectCrossMarketArbitrage(
      { id: 'm1', question: 'Party A wins', outcome: 'Yes', price: 50 },
      { id: 'm2', question: 'Party B wins', outcome: 'Yes', price: 50 },
      'contradictory',
      {},
    );

    expect(result).toBeNull(); // Combined = 100, expected = 100
  });

  test('near 50/50 with small deviation still within threshold', () => {
    const result = detectSingleMarketArbitrage(
      'fifty2',
      'Nearly 50/50',
      [
        { name: 'Yes', price: 50.5 },
        { name: 'No', price: 50.5 },
      ],
    );

    // 101%, deviation = 1 < 3 default threshold
    expect(result).toBeNull();
  });
});

// ─── Cross-Market Arbitrage Advanced ─────────────────────────────────────

describe('Cross-Market Arbitrage Advanced', () => {
  test('complementary markets significantly overpriced', () => {
    const result = detectCrossMarketArbitrage(
      { id: 'm1', question: 'Will policy pass?', outcome: 'Yes', price: 80 },
      { id: 'm2', question: 'Will policy NOT pass?', outcome: 'Yes', price: 30 },
      'complementary',
      {},
    );

    expect(result).not.toBeNull();
    expect(result!.combinedPrice).toBe(110);
    expect(result!.deviation).toBe(10);
    expect(result!.opportunity).toContain('Sell');
  });

  test('complementary markets significantly underpriced', () => {
    const result = detectCrossMarketArbitrage(
      { id: 'm1', question: 'Event occurs', outcome: 'Yes', price: 30 },
      { id: 'm2', question: 'Event does not occur', outcome: 'Yes', price: 60 },
      'complementary',
      {},
    );

    expect(result).not.toBeNull();
    expect(result!.combinedPrice).toBe(90);
    expect(result!.deviation).toBe(10);
    expect(result!.opportunity).toContain('Buy');
  });

  test('correlated markets with diverging current prices', () => {
    const now = Date.now();
    const interval = 300000;
    // Historically both around 50%
    const priceHistory: Record<string, PriceSnapshot[]> = {
      m1: Array.from({ length: 10 }, (_, i) => ({
        timestamp: now - (9 - i) * interval,
        prices: { Yes: 50 },
      })),
      m2: Array.from({ length: 10 }, (_, i) => ({
        timestamp: now - (9 - i) * interval,
        prices: { Yes: 50 },
      })),
    };

    // Now m1=80, m2=80 → combined 160 vs historical 100
    const result = detectCrossMarketArbitrage(
      { id: 'm1', question: 'Market A', outcome: 'Yes', price: 80 },
      { id: 'm2', question: 'Market B', outcome: 'Yes', price: 80 },
      'correlated',
      priceHistory,
    );

    expect(result).not.toBeNull();
    expect(result!.combinedPrice).toBe(160);
    expect(result!.expectedCombined).toBe(100);
    expect(result!.deviation).toBe(60);
  });

  test('correlated markets with no deviation returns null', () => {
    const now = Date.now();
    const interval = 300000;
    const priceHistory: Record<string, PriceSnapshot[]> = {
      m1: Array.from({ length: 10 }, (_, i) => ({
        timestamp: now - (9 - i) * interval,
        prices: { Yes: 50 },
      })),
      m2: Array.from({ length: 10 }, (_, i) => ({
        timestamp: now - (9 - i) * interval,
        prices: { Yes: 50 },
      })),
    };

    const result = detectCrossMarketArbitrage(
      { id: 'm1', question: 'A', outcome: 'Yes', price: 50 },
      { id: 'm2', question: 'B', outcome: 'Yes', price: 50 },
      'correlated',
      priceHistory,
    );

    expect(result).toBeNull(); // Combined = 100, expected = 100
  });

  test('correlated with insufficient history returns null', () => {
    const result = detectCrossMarketArbitrage(
      { id: 'm1', question: 'A', outcome: 'Yes', price: 80 },
      { id: 'm2', question: 'B', outcome: 'Yes', price: 80 },
      'correlated',
      {
        m1: [{ timestamp: Date.now(), prices: { Yes: 50 } }],
        m2: [{ timestamp: Date.now(), prices: { Yes: 50 } }],
      },
    );

    expect(result).toBeNull();
  });

  test('opportunity message includes price details', () => {
    const result = detectCrossMarketArbitrage(
      { id: 'm1', question: 'Market Alpha', outcome: 'Yes', price: 75 },
      { id: 'm2', question: 'Market Beta', outcome: 'Yes', price: 35 },
      'complementary',
      {},
    );

    expect(result).not.toBeNull();
    expect(result!.opportunity).toContain('Market Alpha');
    expect(result!.opportunity).toContain('Market Beta');
    expect(result!.opportunity).toContain('110.0%');
    expect(result!.opportunity).toContain('100.0%');
  });

  test('contradictory with exactly at threshold boundary', () => {
    // Combined = 103, expected = 100, deviation = 3
    // Code checks: if (deviation < 3) return null;
    // 3 < 3 is false, so a result IS returned
    const result = detectCrossMarketArbitrage(
      { id: 'm1', question: 'A wins', outcome: 'Yes', price: 52 },
      { id: 'm2', question: 'B wins', outcome: 'Yes', price: 51 },
      'contradictory',
      {},
    );

    expect(result).not.toBeNull();
    expect(result!.deviation).toBe(3);
    expect(result!.combinedPrice).toBe(103);
  });

  test('contradictory just below threshold returns null', () => {
    const result = detectCrossMarketArbitrage(
      { id: 'm1', question: 'A wins', outcome: 'Yes', price: 51 },
      { id: 'm2', question: 'B wins', outcome: 'Yes', price: 51 },
      'contradictory',
      {},
    );

    // Combined = 102, deviation = 2 < 3 → null
    expect(result).toBeNull();
  });
});

// ─── Scan Edge Cases ────────────────────────────────────────────────────

describe('Scan For Arbitrage - Edge Cases', () => {
  test('all single-outcome markets are skipped', () => {
    const markets = [
      { id: 'm1', question: 'Single', outcomes: [{ name: 'Yes', price: 50 }] },
      { id: 'm2', question: 'Single2', outcomes: [{ name: 'Only', price: 75 }] },
    ];

    const results = scanForArbitrage(markets);
    expect(results).toHaveLength(0);
  });

  test('empty outcomes array is handled', () => {
    const markets = [
      { id: 'm1', question: 'No outcomes', outcomes: [] },
    ];

    const results = scanForArbitrage(markets);
    expect(results).toHaveLength(0);
  });

  test('very large number of markets', () => {
    const markets = Array.from({ length: 50 }, (_, i) => ({
      id: `m${i}`,
      question: `Market ${i}`,
      outcomes: [
        { name: 'Yes', price: 55 },
        { name: 'No', price: 55 },
      ], // All 110% → all overpriced
    }));

    const results = scanForArbitrage(markets);
    expect(results.length).toBe(50);
    results.forEach(r => {
      expect(r.type).toBe('overpriced');
      expect(r.deviation).toBe(10);
    });
  });

  test('scan preserves market metadata', () => {
    const markets = [
      {
        id: 'unique-id-123',
        question: 'Will it rain on Mars?',
        outcomes: [
          { name: 'Yes', price: 70 },
          { name: 'No', price: 50 },
        ],
      },
    ];

    const results = scanForArbitrage(markets);
    expect(results[0].marketId).toBe('unique-id-123');
    expect(results[0].question).toBe('Will it rain on Mars?');
    expect(results[0].outcomes).toHaveLength(2);
  });

  test('scan with negative prices', () => {
    const markets = [
      {
        id: 'm1',
        question: 'Negative edge case',
        outcomes: [
          { name: 'Yes', price: -5 },
          { name: 'No', price: 80 },
        ],
      },
    ];

    const results = scanForArbitrage(markets);
    // Total = 75, deviation = 25
    expect(results.length).toBe(1);
    expect(results[0].type).toBe('underpriced');
  });

  test('mixed overpriced and underpriced sorted by profit', () => {
    const markets = [
      {
        id: 'over',
        question: 'Overpriced',
        outcomes: [{ name: 'Yes', price: 60 }, { name: 'No', price: 60 }], // 120%
      },
      {
        id: 'under',
        question: 'Underpriced',
        outcomes: [{ name: 'Yes', price: 25 }, { name: 'No', price: 25 }], // 50%
      },
    ];

    const results = scanForArbitrage(markets);
    expect(results.length).toBe(2);
    // Under has bigger deviation (50 vs 20)
    expect(results[0].marketId).toBe('under');
    expect(results[0].deviation).toBe(50);
    expect(results[1].marketId).toBe('over');
    expect(results[1].deviation).toBe(20);
  });
});
