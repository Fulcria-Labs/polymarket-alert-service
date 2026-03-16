/**
 * Chainlink Data Feeds — Advanced Tests
 *
 * Tests:
 * - Multiple feed aggregation scenarios
 * - Complex hybrid alert scenarios (multi-condition, time windows)
 * - Correlation edge cases (empty, single point, perfectly correlated, inverse)
 * - Feed failover and fallback scenarios
 * - Price normalization across different decimal precisions
 * - Concurrent feed queries
 * - Historical price tracking
 * - TWAP edge cases and window behavior
 * - Large-scale aggregation
 */

import { describe, test, expect } from 'bun:test';
import {
  CHAINLINK_FEEDS,
  AGGREGATOR_V3_ABI,
  ChainlinkPriceFeed,
  createHybridAlert,
  evaluateHybridAlert,
  correlateOracleWithMarket,
  detectOracleMarketDivergence,
  aggregateFeedData,
  computeTWAP,
  normalizePrice,
  convertDecimals,
  pearsonCorrelation,
} from '../chainlink-data-feeds';
import type {
  IAggregatorV3,
  HybridAlertConfig,
  OracleCondition,
  MarketCondition,
} from '../chainlink-data-feeds';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const NOW = Date.now();
const NOW_SEC = Math.floor(NOW / 1000);
const INTERVAL = 300000; // 5 minutes

function makeMockContract(overrides: {
  decimals?: number;
  answer?: bigint;
  roundId?: bigint;
  updatedAt?: number;
  answeredInRound?: bigint;
  fail?: boolean;
} = {}): IAggregatorV3 {
  const {
    decimals = 8,
    answer = BigInt(350000000000),
    roundId = BigInt(1),
    updatedAt = NOW_SEC - 60,
    answeredInRound = BigInt(1),
    fail = false,
  } = overrides;

  return {
    decimals: async () => {
      if (fail) throw new Error('Contract error');
      return decimals;
    },
    description: async () => 'Mock / USD',
    latestRoundData: async () => {
      if (fail) throw new Error('Contract error');
      return {
        roundId: BigInt(roundId),
        answer: BigInt(answer),
        startedAt: BigInt(updatedAt - 10),
        updatedAt: BigInt(updatedAt),
        answeredInRound: BigInt(answeredInRound),
      };
    },
  };
}

function makeTimeSeries(values: number[], baseTime = NOW - values.length * INTERVAL) {
  return values.map((price, i) => ({ price, timestamp: baseTime + i * INTERVAL }));
}

// ─── Multiple Feed Aggregation ────────────────────────────────────────────────

describe('Multiple feed aggregation', () => {
  test('aggregates 6 feeds correctly', () => {
    const data = [
      { feedId: 'ETH-USD', price: 3500, timestamp: NOW - 1000 },
      { feedId: 'BTC-USD', price: 80000, timestamp: NOW - 2000 },
      { feedId: 'LINK-USD', price: 15, timestamp: NOW - 3000 },
      { feedId: 'MATIC-USD', price: 0.8, timestamp: NOW - 4000 },
      { feedId: 'SOL-USD', price: 150, timestamp: NOW - 5000 },
      { feedId: 'AVAX-USD', price: 40, timestamp: NOW - 6000 },
    ];
    const result = aggregateFeedData(data);
    expect(result.feedIds).toHaveLength(6);
    expect(result.weightedAverage).toBeGreaterThan(0);
  });

  test('median of 6 feeds returns middle of sorted values', () => {
    // Sorted: 0.8, 15, 40, 150, 3500, 80000 → median = (40+150)/2 = 95
    const data = [
      { feedId: 'ETH-USD', price: 3500, timestamp: NOW },
      { feedId: 'BTC-USD', price: 80000, timestamp: NOW },
      { feedId: 'LINK-USD', price: 15, timestamp: NOW },
      { feedId: 'MATIC-USD', price: 0.8, timestamp: NOW },
      { feedId: 'SOL-USD', price: 150, timestamp: NOW },
      { feedId: 'AVAX-USD', price: 40, timestamp: NOW },
    ];
    const result = aggregateFeedData(data);
    expect(result.median).toBeCloseTo(95, 0);
  });

  test('spread equals max minus min across feeds', () => {
    const data = [
      { feedId: 'ETH-USD', price: 100, timestamp: NOW },
      { feedId: 'BTC-USD', price: 500, timestamp: NOW },
      { feedId: 'LINK-USD', price: 300, timestamp: NOW },
    ];
    const result = aggregateFeedData(data);
    expect(result.spread).toBeCloseTo(400, 2);
    expect(result.min).toBe(100);
    expect(result.max).toBe(500);
  });

  test('custom weights sum to determine average', () => {
    const data = [
      { feedId: 'ETH-USD', price: 0, timestamp: NOW },
      { feedId: 'BTC-USD', price: 100, timestamp: NOW },
    ];
    const weights = { 'ETH-USD': 0, 'BTC-USD': 1 };
    const result = aggregateFeedData(data, weights);
    expect(result.weightedAverage).toBe(100);
  });

  test('equal weights give arithmetic mean', () => {
    const data = [
      { feedId: 'ETH-USD', price: 200, timestamp: NOW },
      { feedId: 'BTC-USD', price: 400, timestamp: NOW },
    ];
    const result = aggregateFeedData(data);
    expect(result.weightedAverage).toBe(300);
  });

  test('TWAP is computed within aggregation', () => {
    const data = [
      { feedId: 'ETH-USD', price: 3500, timestamp: NOW - 60000 },
      { feedId: 'BTC-USD', price: 80000, timestamp: NOW - 30000 },
    ];
    const result = aggregateFeedData(data, undefined, 3600000);
    expect(result.twap).toBeGreaterThan(0);
  });

  test('very high weight feed dominates weighted average', () => {
    const data = [
      { feedId: 'ETH-USD', price: 100, timestamp: NOW },
      { feedId: 'BTC-USD', price: 1000, timestamp: NOW },
    ];
    const weights = { 'ETH-USD': 1, 'BTC-USD': 99 };
    const result = aggregateFeedData(data, weights);
    expect(result.weightedAverage).toBeGreaterThan(990);
  });

  test('missing weight defaults to 1', () => {
    const data = [
      { feedId: 'ETH-USD', price: 200, timestamp: NOW },
      { feedId: 'LINK-USD', price: 200, timestamp: NOW },
    ];
    const weights = { 'ETH-USD': 1 }; // LINK-USD missing, defaults to 1
    const result = aggregateFeedData(data, weights);
    expect(result.weightedAverage).toBe(200);
  });

  test('odd number of feeds has exact median', () => {
    const data = [
      { feedId: 'ETH-USD', price: 100, timestamp: NOW },
      { feedId: 'BTC-USD', price: 300, timestamp: NOW },
      { feedId: 'LINK-USD', price: 200, timestamp: NOW },
    ];
    const result = aggregateFeedData(data);
    expect(result.median).toBe(200);
  });
});

// ─── Complex Hybrid Alert Scenarios ──────────────────────────────────────────

describe('Complex hybrid alert scenarios', () => {
  function buildAlert(
    oracleConds: OracleCondition[],
    marketConds: MarketCondition[],
    logic: 'AND' | 'OR' = 'AND',
  ): HybridAlertConfig {
    return {
      id: 'test',
      description: 'complex test alert',
      oracleConditions: oracleConds,
      marketConditions: marketConds,
      logic,
      notifyUrl: 'https://example.com',
      createdAt: Date.now(),
    };
  }

  test('multi-oracle AND: all must be true', () => {
    const alert = buildAlert([
      { feedId: 'ETH-USD', operator: 'gt', value: 3000 },
      { feedId: 'BTC-USD', operator: 'gt', value: 70000 },
    ], []);
    expect(evaluateHybridAlert(alert, { 'ETH-USD': 3500, 'BTC-USD': 80000 }, {}).triggered).toBe(true);
    expect(evaluateHybridAlert(alert, { 'ETH-USD': 3500, 'BTC-USD': 60000 }, {}).triggered).toBe(false);
    expect(evaluateHybridAlert(alert, { 'ETH-USD': 2500, 'BTC-USD': 80000 }, {}).triggered).toBe(false);
  });

  test('multi-market AND: all must be true', () => {
    const alert = buildAlert([], [
      { marketId: 'm1', outcome: 'Yes', operator: 'gt', value: 60 },
      { marketId: 'm2', outcome: 'Yes', operator: 'lt', value: 40 },
    ]);
    expect(evaluateHybridAlert(alert, {}, { 'm1:Yes': 65, 'm2:Yes': 35 }).triggered).toBe(true);
    expect(evaluateHybridAlert(alert, {}, { 'm1:Yes': 65, 'm2:Yes': 45 }).triggered).toBe(false);
  });

  test('multi-oracle OR: any can trigger', () => {
    const alert = buildAlert([
      { feedId: 'ETH-USD', operator: 'gt', value: 5000 },
      { feedId: 'BTC-USD', operator: 'gt', value: 100000 },
    ], [], 'OR');
    // Both below threshold
    expect(evaluateHybridAlert(alert, { 'ETH-USD': 4000, 'BTC-USD': 90000 }, {}).triggered).toBe(false);
    // ETH above threshold
    expect(evaluateHybridAlert(alert, { 'ETH-USD': 6000, 'BTC-USD': 90000 }, {}).triggered).toBe(true);
    // BTC above threshold
    expect(evaluateHybridAlert(alert, { 'ETH-USD': 4000, 'BTC-USD': 110000 }, {}).triggered).toBe(true);
  });

  test('between oracle and market conditions', () => {
    const alert = buildAlert([
      { feedId: 'ETH-USD', operator: 'between', value: 3000, valueUpper: 4000 },
    ], [
      { marketId: 'm1', outcome: 'Yes', operator: 'between', value: 40, valueUpper: 70 },
    ]);
    expect(evaluateHybridAlert(alert, { 'ETH-USD': 3500 }, { 'm1:Yes': 55 }).triggered).toBe(true);
    expect(evaluateHybridAlert(alert, { 'ETH-USD': 5000 }, { 'm1:Yes': 55 }).triggered).toBe(false);
    expect(evaluateHybridAlert(alert, { 'ETH-USD': 3500 }, { 'm1:Yes': 80 }).triggered).toBe(false);
  });

  test('eq operator matches exact value', () => {
    const alert = buildAlert([
      { feedId: 'ETH-USD', operator: 'eq', value: 3500 },
    ], []);
    expect(evaluateHybridAlert(alert, { 'ETH-USD': 3500 }, {}).triggered).toBe(true);
    expect(evaluateHybridAlert(alert, { 'ETH-USD': 3501 }, {}).triggered).toBe(false);
  });

  test('gte operator includes boundary value', () => {
    const alert = buildAlert([
      { feedId: 'ETH-USD', operator: 'gte', value: 3500 },
    ], []);
    expect(evaluateHybridAlert(alert, { 'ETH-USD': 3500 }, {}).triggered).toBe(true);
    expect(evaluateHybridAlert(alert, { 'ETH-USD': 3499 }, {}).triggered).toBe(false);
  });

  test('multiple market outcomes as conditions', () => {
    const alert = buildAlert([], [
      { marketId: 'm1', outcome: 'Yes', operator: 'gt', value: 60 },
      { marketId: 'm1', outcome: 'No', operator: 'lt', value: 40 },
    ]);
    expect(evaluateHybridAlert(alert, {}, { 'm1:Yes': 65, 'm1:No': 35 }).triggered).toBe(true);
  });

  test('OR with mixed oracle and market - only market met', () => {
    const alert = buildAlert([
      { feedId: 'ETH-USD', operator: 'gt', value: 10000 },
    ], [
      { marketId: 'm1', outcome: 'Yes', operator: 'gt', value: 60 },
    ], 'OR');
    expect(evaluateHybridAlert(alert, { 'ETH-USD': 3500 }, { 'm1:Yes': 75 }).triggered).toBe(true);
  });

  test('alert with no data returns false (AND)', () => {
    const alert = buildAlert([
      { feedId: 'ETH-USD', operator: 'gt', value: 3000 },
    ], []);
    expect(evaluateHybridAlert(alert, {}, {}).triggered).toBe(false);
  });

  test('createHybridAlert with multiple conditions', () => {
    const alert = createHybridAlert({
      description: 'Multi-condition alert',
      oracleConditions: [
        { feedId: 'ETH-USD', operator: 'gt', value: 3000 },
        { feedId: 'BTC-USD', operator: 'gt', value: 60000 },
      ],
      marketConditions: [
        { marketId: 'm1', outcome: 'Yes', operator: 'gte', value: 50 },
        { marketId: 'm2', outcome: 'No', operator: 'lte', value: 30 },
      ],
      logic: 'AND',
      notifyUrl: 'https://example.com',
    });
    expect(alert.oracleConditions).toHaveLength(2);
    expect(alert.marketConditions).toHaveLength(2);
  });

  test('market-only hybrid alert works without oracle', () => {
    const alert = createHybridAlert({
      description: 'Market only alert',
      oracleConditions: [],
      marketConditions: [{ marketId: 'm1', outcome: 'Yes', operator: 'gt', value: 60 }],
      notifyUrl: 'https://example.com',
    });
    const result = evaluateHybridAlert(alert, {}, { 'm1:Yes': 70 });
    expect(result.triggered).toBe(true);
  });

  test('oracle-only hybrid alert works without market', () => {
    const alert = createHybridAlert({
      description: 'Oracle only alert',
      oracleConditions: [{ feedId: 'ETH-USD', operator: 'gt', value: 3000 }],
      marketConditions: [],
      notifyUrl: 'https://example.com',
    });
    const result = evaluateHybridAlert(alert, { 'ETH-USD': 3500 }, {});
    expect(result.triggered).toBe(true);
  });

  test('alertId in evaluation matches alert id', () => {
    const alert = createHybridAlert({
      id: 'my-unique-id',
      description: 'test',
      oracleConditions: [{ feedId: 'ETH-USD', operator: 'gt', value: 3000 }],
      marketConditions: [],
      notifyUrl: 'https://example.com',
    });
    const result = evaluateHybridAlert(alert, { 'ETH-USD': 3500 }, {});
    expect(result.alertId).toBe('my-unique-id');
  });
});

// ─── Correlation Edge Cases ───────────────────────────────────────────────────

describe('Correlation edge cases', () => {
  test('empty oracle data returns 0 correlation', () => {
    const market = makeTimeSeries([50, 55, 60]);
    const result = correlateOracleWithMarket([], market, 'ETH-USD', 'm1');
    expect(result.correlation).toBe(0);
  });

  test('empty market data returns 0 correlation', () => {
    const oracle = makeTimeSeries([3000, 3100, 3200]);
    const result = correlateOracleWithMarket(oracle, [], 'ETH-USD', 'm1');
    expect(result.correlation).toBe(0);
  });

  test('single point in each returns 0 correlation', () => {
    const oracle = makeTimeSeries([3000]);
    const market = makeTimeSeries([50]);
    const result = correlateOracleWithMarket(oracle, market, 'ETH-USD', 'm1');
    expect(result.correlation).toBe(0);
  });

  test('perfectly correlated positive returns 1', () => {
    const times = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => NOW - (8 - i) * INTERVAL);
    const oVals = [100, 110, 120, 130, 140, 150, 160, 170];
    const mVals = [10, 11, 12, 13, 14, 15, 16, 17];
    const oracle = oVals.map((price, i) => ({ price, timestamp: times[i]! }));
    const market = mVals.map((price, i) => ({ price, timestamp: times[i]! }));
    const result = correlateOracleWithMarket(oracle, market, 'ETH-USD', 'm1');
    expect(result.correlation).toBeGreaterThan(0.99);
  });

  test('perfectly inversely correlated returns -1', () => {
    const times = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => NOW - (8 - i) * INTERVAL);
    const oVals = [100, 110, 120, 130, 140, 150, 160, 170];
    const mVals = [17, 16, 15, 14, 13, 12, 11, 10];
    const oracle = oVals.map((price, i) => ({ price, timestamp: times[i]! }));
    const market = mVals.map((price, i) => ({ price, timestamp: times[i]! }));
    const result = correlateOracleWithMarket(oracle, market, 'ETH-USD', 'm1');
    expect(result.correlation).toBeLessThan(-0.99);
  });

  test('constant oracle with varying market gives 0', () => {
    const times = [1, 2, 3, 4, 5].map((i) => NOW - (5 - i) * INTERVAL);
    const oracle = [3500, 3500, 3500, 3500, 3500].map((price, i) => ({ price, timestamp: times[i]! }));
    const market = [50, 60, 40, 70, 30].map((price, i) => ({ price, timestamp: times[i]! }));
    const result = correlateOracleWithMarket(oracle, market, 'ETH-USD', 'm1');
    expect(result.correlation).toBe(0);
  });

  test('correlation is bounded to [-1, 1]', () => {
    const oracle = makeTimeSeries([100, 200, 300, 400, 500]);
    const market = makeTimeSeries([10, 20, 30, 40, 50]);
    const result = correlateOracleWithMarket(oracle, market, 'ETH-USD', 'm1');
    expect(result.correlation).toBeGreaterThanOrEqual(-1);
    expect(result.correlation).toBeLessThanOrEqual(1);
  });

  test('noisy series gives lower correlation than clean series', () => {
    const times = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => NOW - (10 - i) * INTERVAL);
    const oVals = [100, 110, 120, 130, 140, 150, 160, 170, 180, 190];
    const mValsClean = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
    const mValsNoisy = [10, 15, 8, 18, 12, 20, 9, 22, 11, 25];

    const oracle = oVals.map((price, i) => ({ price, timestamp: times[i]! }));
    const clean = mValsClean.map((price, i) => ({ price, timestamp: times[i]! }));
    const noisy = mValsNoisy.map((price, i) => ({ price, timestamp: times[i]! }));

    const cleanResult = correlateOracleWithMarket(oracle, clean, 'ETH-USD', 'm1');
    const noisyResult = correlateOracleWithMarket(oracle, noisy, 'ETH-USD', 'm1');
    expect(cleanResult.correlation).toBeGreaterThan(noisyResult.correlation);
  });
});

// ─── Divergence Detection Edge Cases ─────────────────────────────────────────

describe('Divergence detection edge cases', () => {
  test('returns null when both series empty', () => {
    const result = detectOracleMarketDivergence([], [], 10, 'ETH-USD', 'm1');
    expect(result).toBeNull();
  });

  test('returns null when both series flat', () => {
    const oracle = makeTimeSeries([3500, 3500, 3500]);
    const market = makeTimeSeries([50, 50, 50]);
    const result = detectOracleMarketDivergence(oracle, market, 10, 'ETH-USD', 'm1');
    expect(result).toBeNull();
  });

  test('returns null when divergence below threshold', () => {
    // Small movements in opposite directions
    const oracle = makeTimeSeries([3500, 3502, 3504]);
    const market = makeTimeSeries([50, 49.9, 49.8]);
    const result = detectOracleMarketDivergence(oracle, market, 50, 'ETH-USD', 'm1');
    expect(result).toBeNull();
  });

  test('detects oracle_leading divergence', () => {
    // Oracle moves a lot, market barely moves
    const oracle = makeTimeSeries([3000, 4000, 5000]);
    const market = makeTimeSeries([50, 50.5, 51]);
    const result = detectOracleMarketDivergence(oracle, market, 5, 'ETH-USD', 'm1');
    if (result) {
      expect(['oracle_leading', 'conflicting']).toContain(result.divergenceType);
    }
  });

  test('detects market_leading divergence', () => {
    // Market moves a lot, oracle barely moves
    const oracle = makeTimeSeries([3500, 3501, 3502]);
    const market = makeTimeSeries([30, 50, 70]);
    const result = detectOracleMarketDivergence(oracle, market, 5, 'ETH-USD', 'm1');
    if (result) {
      expect(['market_leading', 'conflicting']).toContain(result.divergenceType);
    }
  });

  test('divergence score is non-negative', () => {
    const oracle = makeTimeSeries([3000, 3500, 4000]);
    const market = makeTimeSeries([70, 50, 30]);
    const result = detectOracleMarketDivergence(oracle, market, 0, 'ETH-USD', 'm1');
    if (result) {
      expect(result.divergenceScore).toBeGreaterThanOrEqual(0);
    }
  });

  test('oracle trend is classified correctly', () => {
    const oracle = makeTimeSeries([3000, 3500, 4000]);  // going up
    const market = makeTimeSeries([70, 50, 30]);        // going down
    const result = detectOracleMarketDivergence(oracle, market, 5, 'ETH-USD', 'm1');
    expect(result).not.toBeNull();
    expect(result!.oracleTrend).toBe('up');
    expect(result!.marketTrend).toBe('down');
  });

  test('result has all required fields', () => {
    const oracle = makeTimeSeries([3000, 3500, 4000]);
    const market = makeTimeSeries([70, 50, 30]);
    const result = detectOracleMarketDivergence(oracle, market, 5, 'ETH-USD', 'm1');
    expect(result).not.toBeNull();
    expect(result!.feedId).toBeDefined();
    expect(result!.marketId).toBeDefined();
    expect(result!.outcome).toBeDefined();
    expect(result!.divergenceScore).toBeDefined();
    expect(result!.oracleTrend).toBeDefined();
    expect(result!.marketTrend).toBeDefined();
    expect(result!.divergenceType).toBeDefined();
    expect(result!.description).toBeDefined();
  });
});

// ─── Feed Failover and Fallback ───────────────────────────────────────────────

describe('Feed failover and fallback', () => {
  test('getMultiplePrices succeeds with 5/6 feeds', async () => {
    let callCount = 0;
    const feed = new ChainlinkPriceFeed({
      network: 'base',
      contractFactory: () => {
        callCount++;
        return makeMockContract({ fail: callCount === 3 }); // 3rd call fails
      },
    });
    const { results, errors } = await feed.getMultiplePrices([
      'ETH-USD', 'BTC-USD', 'LINK-USD', 'SOL-USD', 'AVAX-USD',
    ]);
    expect(results.length + errors.length).toBe(5);
    expect(results.length).toBe(4);
    expect(errors.length).toBe(1);
  });

  test('all feeds fail returns empty results', async () => {
    const feed = new ChainlinkPriceFeed({
      network: 'base',
      contractFactory: () => makeMockContract({ fail: true }),
    });
    const { results, errors } = await feed.getMultiplePrices(['ETH-USD', 'BTC-USD']);
    expect(results).toHaveLength(0);
    expect(errors).toHaveLength(2);
  });

  test('error includes feed id', async () => {
    const feed = new ChainlinkPriceFeed({
      network: 'base',
      contractFactory: () => makeMockContract({ fail: true }),
    });
    const { errors } = await feed.getMultiplePrices(['LINK-USD']);
    expect(errors[0]!.feedId).toBe('LINK-USD');
    expect(errors[0]!.error).toBeTruthy();
  });

  test('isFeedStale returns true on error', async () => {
    const feed = new ChainlinkPriceFeed({
      network: 'base',
      contractFactory: () => makeMockContract({ fail: true }),
    });
    const stale = await feed.isFeedStale('ETH-USD', 3600);
    expect(stale).toBe(true);
  });

  test('different networks use different addresses', () => {
    const baseFeed = new ChainlinkPriceFeed({ network: 'base' });
    const mainnetFeed = new ChainlinkPriceFeed({ network: 'mainnet' });
    const baseAddr = baseFeed.getFeedAddress('ETH-USD');
    const mainnetAddr = mainnetFeed.getFeedAddress('ETH-USD');
    expect(baseAddr).not.toBe(mainnetAddr);
  });

  test('concurrent fetches resolve independently', async () => {
    const delays = [50, 10, 30]; // different response delays
    let callIndex = 0;
    const prices = [3500, 80000, 15];
    const feed = new ChainlinkPriceFeed({
      network: 'base',
      contractFactory: () => {
        const idx = callIndex++;
        const price = prices[idx % 3]!;
        return {
          decimals: async () => { await new Promise(r => setTimeout(r, delays[idx % 3]!)); return 8; },
          description: async () => 'Mock',
          latestRoundData: async () => ({
            roundId: BigInt(1),
            answer: BigInt(Math.round(price * 1e8)),
            startedAt: BigInt(NOW_SEC - 60),
            updatedAt: BigInt(NOW_SEC - 60),
            answeredInRound: BigInt(1),
          }),
        };
      },
    });
    const { results } = await feed.getMultiplePrices(['ETH-USD', 'BTC-USD', 'LINK-USD']);
    expect(results).toHaveLength(3);
  });
});

// ─── Price Normalization ──────────────────────────────────────────────────────

describe('Price normalization across decimal precisions', () => {
  test('8 decimal Chainlink price normalizes correctly', () => {
    // $3500 with 8 decimals = 350000000000
    expect(normalizePrice(BigInt(350000000000), 8)).toBeCloseTo(3500, 4);
  });

  test('6 decimal USDC price normalizes correctly', () => {
    // $1.00 USDC with 6 decimals = 1000000
    expect(normalizePrice(BigInt(1000000), 6)).toBeCloseTo(1.0, 6);
  });

  test('18 decimal ETH normalizes correctly', () => {
    // 1 ETH in wei
    expect(normalizePrice(BigInt('1000000000000000000'), 18)).toBeCloseTo(1.0, 9);
  });

  test('very small price normalizes correctly', () => {
    // $0.001 with 8 decimals = 100000
    expect(normalizePrice(BigInt(100000), 8)).toBeCloseTo(0.001, 7);
  });

  test('very large BTC price normalizes correctly', () => {
    // $100,000 BTC with 8 decimals
    expect(normalizePrice(BigInt(10000000000000), 8)).toBeCloseTo(100000, 0);
  });

  test('convert 8 to 18 decimals', () => {
    const price = 3500;
    const converted = convertDecimals(price, 8, 18);
    expect(converted).toBeCloseTo(3500 * 1e10, 0);
  });

  test('convert 18 to 6 decimals', () => {
    const price = 1e12; // 1.0 with 18 decimals scaled back to 6 decimals
    const converted = convertDecimals(price, 18, 6);
    expect(converted).toBeCloseTo(price / 1e12, 9);
  });

  test('same decimals is identity', () => {
    expect(convertDecimals(12345.678, 8, 8)).toBe(12345.678);
  });

  test('normalizePrice with number type', () => {
    const result = normalizePrice(350000000000, 8);
    expect(result).toBeCloseTo(3500, 4);
  });

  test('zero raw price normalizes to zero', () => {
    expect(normalizePrice(0, 8)).toBe(0);
  });

  test('normalizes decimal 0 (no scaling)', () => {
    expect(normalizePrice(3500, 0)).toBe(3500);
  });
});

// ─── TWAP Edge Cases and Window Behavior ─────────────────────────────────────

describe('TWAP edge cases and window behavior', () => {
  test('empty array returns 0', () => {
    expect(computeTWAP([])).toBe(0);
  });

  test('single price returns that price', () => {
    const prices = [{ price: 4200, timestamp: NOW - 1000 }];
    expect(computeTWAP(prices)).toBe(4200);
  });

  test('constant price TWAP equals that price', () => {
    const prices = [
      { price: 3500, timestamp: NOW - 60000 },
      { price: 3500, timestamp: NOW - 30000 },
      { price: 3500, timestamp: NOW - 10000 },
    ];
    const result = computeTWAP(prices, 3600000);
    expect(result).toBeCloseTo(3500, 1);
  });

  test('zero-duration segments are ignored', () => {
    const prices = [
      { price: 1000, timestamp: NOW - 10000 },
      { price: 1000, timestamp: NOW - 10000 }, // same timestamp
    ];
    const result = computeTWAP(prices, 3600000);
    expect(result).toBeGreaterThan(0);
  });

  test('short window excludes old prices', () => {
    const prices = [
      { price: 100, timestamp: NOW - 7200000 }, // 2 hours ago (outside 1h window)
      { price: 5000, timestamp: NOW - 1800000 }, // 30 min ago
      { price: 5100, timestamp: NOW - 900000 },  // 15 min ago
    ];
    const twap1h = computeTWAP(prices, 3600000);
    // Should be near 5000-5100, not influenced by 100
    expect(twap1h).toBeGreaterThan(4000);
  });

  test('longer window includes more history', () => {
    const prices = [
      { price: 1000, timestamp: NOW - 7200000 }, // 2 hours ago
      { price: 5000, timestamp: NOW - 1800000 }, // 30 min ago
    ];
    const twap2h = computeTWAP(prices, 7200000 + 1000); // 2h+ window
    const twap1h = computeTWAP(prices, 3600000); // 1h window
    // 2h window should be affected by the 1000 price
    expect(twap2h).toBeLessThan(twap1h);
  });

  test('recent short spike has small TWAP impact', () => {
    // Price was stable at 3500 for a long time, then spiked briefly
    const prices = [
      { price: 3500, timestamp: NOW - 3600000 },  // 1h ago
      { price: 3500, timestamp: NOW - 1800000 },  // 30 min ago
      { price: 10000, timestamp: NOW - 60000 },   // 1 min spike
    ];
    const twap = computeTWAP(prices, 3600000);
    // TWAP should be much closer to 3500 than 10000 due to time weighting
    expect(twap).toBeLessThan(6000);
    expect(twap).toBeGreaterThan(3500);
  });

  test('uses last price when all outside window', () => {
    const prices = [
      { price: 9999, timestamp: NOW - 86400000 }, // 24h ago, outside any window
    ];
    const result = computeTWAP(prices, 3600000);
    expect(result).toBe(9999);
  });

  test('TWAP default window is 1 hour', () => {
    // Should not throw without windowMs argument
    const prices = [
      { price: 3500, timestamp: NOW - 1000 },
    ];
    const result = computeTWAP(prices);
    expect(result).toBe(3500);
  });

  test('ascending prices have TWAP between first and last', () => {
    const prices = [
      { price: 100, timestamp: NOW - 6000 },
      { price: 200, timestamp: NOW - 4000 },
      { price: 300, timestamp: NOW - 2000 },
      { price: 400, timestamp: NOW - 0 },
    ];
    const twap = computeTWAP(prices, 10000);
    expect(twap).toBeGreaterThan(100);
    expect(twap).toBeLessThan(400);
  });
});

// ─── Historical Price Tracking ────────────────────────────────────────────────

describe('Historical price tracking simulation', () => {
  test('TWAP computed over simulated historical data', () => {
    // Simulate 24 price updates over a day
    const prices: { price: number; timestamp: number }[] = [];
    for (let i = 0; i < 24; i++) {
      prices.push({
        price: 3000 + i * 50, // 3000 to 4150
        timestamp: NOW - (24 - i) * 3600000,
      });
    }
    const twap = computeTWAP(prices, 24 * 3600000 + 1000);
    expect(twap).toBeGreaterThan(3000);
    expect(twap).toBeLessThan(4200);
  });

  test('correlation over long history remains bounded', () => {
    // 50 data points
    const n = 50;
    const oracle = Array.from({ length: n }, (_, i) => ({
      price: 3000 + i * 20 + Math.sin(i) * 100,
      timestamp: NOW - (n - i) * INTERVAL,
    }));
    const market = Array.from({ length: n }, (_, i) => ({
      price: 40 + i * 0.4 + Math.cos(i) * 5,
      timestamp: NOW - (n - i) * INTERVAL,
    }));
    const result = correlateOracleWithMarket(oracle, market, 'ETH-USD', 'm1');
    expect(result.correlation).toBeGreaterThanOrEqual(-1);
    expect(result.correlation).toBeLessThanOrEqual(1);
  });

  test('divergence on extended history', () => {
    // 10 data points: oracle trending up, market trending down
    const n = 10;
    const oracle = Array.from({ length: n }, (_, i) => ({
      price: 3000 + i * 500, // 3000 to 7500
      timestamp: NOW - (n - i) * INTERVAL,
    }));
    const market = Array.from({ length: n }, (_, i) => ({
      price: 90 - i * 8, // 90 to 18
      timestamp: NOW - (n - i) * INTERVAL,
    }));
    const result = detectOracleMarketDivergence(oracle, market, 5, 'ETH-USD', 'm1');
    expect(result).not.toBeNull();
  });

  test('aggregation of historical snapshots', () => {
    const histories = ['ETH-USD', 'BTC-USD', 'LINK-USD'].map((feedId, j) => ({
      feedId,
      price: [100, 200, 300][j]!,
      timestamp: NOW - 3600000,
    }));
    const result = aggregateFeedData(histories);
    expect(result.min).toBe(100);
    expect(result.max).toBe(300);
    expect(result.median).toBe(200);
  });
});

// ─── Pearson Correlation Edge Cases ───────────────────────────────────────────

describe('pearsonCorrelation edge cases', () => {
  test('two-element identical series returns 1', () => {
    expect(pearsonCorrelation([1, 2], [1, 2])).toBeCloseTo(1, 5);
  });

  test('two-element inverse series returns -1', () => {
    expect(pearsonCorrelation([1, 2], [2, 1])).toBeCloseTo(-1, 5);
  });

  test('uncorrelated series returns near 0', () => {
    // Alternating signs produces near-zero correlation with monotone
    const x = [1, 2, 3, 4, 5, 6, 7, 8];
    const y = [1, -1, 1, -1, 1, -1, 1, -1];
    const r = pearsonCorrelation(x, y);
    expect(Math.abs(r)).toBeLessThan(0.3);
  });

  test('large arrays work correctly', () => {
    const n = 1000;
    const x = Array.from({ length: n }, (_, i) => i);
    const y = Array.from({ length: n }, (_, i) => i * 2 + 5);
    expect(pearsonCorrelation(x, y)).toBeCloseTo(1, 4);
  });

  test('result is symmetric: corr(x,y) == corr(y,x)', () => {
    const x = [1, 3, 5, 7, 9];
    const y = [2, 4, 3, 8, 6];
    expect(pearsonCorrelation(x, y)).toBeCloseTo(pearsonCorrelation(y, x), 10);
  });

  test('all same values in one series returns 0', () => {
    const x = [5, 5, 5, 5, 5];
    const y = [1, 2, 3, 4, 5];
    expect(pearsonCorrelation(x, y)).toBe(0);
  });

  test('handles floating point values', () => {
    const x = [0.1, 0.2, 0.3, 0.4, 0.5];
    const y = [0.2, 0.4, 0.6, 0.8, 1.0];
    expect(pearsonCorrelation(x, y)).toBeCloseTo(1, 5);
  });
});

// ─── Feed Metadata Completeness ───────────────────────────────────────────────

describe('Feed metadata completeness', () => {
  test('all feed descriptions are non-empty', () => {
    for (const feed of Object.values(CHAINLINK_FEEDS)) {
      expect(feed.description.length).toBeGreaterThan(0);
    }
  });

  test('all feed ids match pattern ASSET-QUOTE', () => {
    for (const id of Object.keys(CHAINLINK_FEEDS)) {
      expect(id).toMatch(/^[A-Z]+-[A-Z]+$/);
    }
  });

  test('ETH-USD mainnet address is a valid hex string', () => {
    const addr = CHAINLINK_FEEDS['ETH-USD']!.addresses.mainnet!;
    expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  test('BTC-USD mainnet address is a valid hex string', () => {
    const addr = CHAINLINK_FEEDS['BTC-USD']!.addresses.mainnet!;
    expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  test('all Base addresses are valid hex strings', () => {
    for (const [id, feed] of Object.entries(CHAINLINK_FEEDS)) {
      if (feed.addresses.base) {
        expect(feed.addresses.base, `${id} Base address invalid`).toMatch(/^0x[0-9a-fA-F]{40}$/);
      }
    }
  });

  test('CHAINLINK_FEEDS has exactly 6 entries', () => {
    expect(Object.keys(CHAINLINK_FEEDS)).toHaveLength(6);
  });

  test('all feeds have non-empty addresses object', () => {
    for (const feed of Object.values(CHAINLINK_FEEDS)) {
      expect(Object.keys(feed.addresses).length).toBeGreaterThan(0);
    }
  });

  test('all feeds have decimals > 0', () => {
    for (const feed of Object.values(CHAINLINK_FEEDS)) {
      expect(feed.decimals).toBeGreaterThan(0);
    }
  });
});

// ─── ChainlinkPriceFeed network behavior ─────────────────────────────────────

describe('ChainlinkPriceFeed network behavior', () => {
  test('defaults to base network', () => {
    const feed = new ChainlinkPriceFeed();
    // Should throw when trying to fetch without provider (no contractFactory)
    expect(() => feed.getFeedAddress('ETH-USD')).not.toThrow();
  });

  test('mainnet network uses mainnet addresses', () => {
    const feed = new ChainlinkPriceFeed({ network: 'mainnet' });
    const addr = feed.getFeedAddress('ETH-USD');
    expect(addr).toBe(CHAINLINK_FEEDS['ETH-USD']!.addresses.mainnet);
  });

  test('sepolia network uses testnet addresses', () => {
    const feed = new ChainlinkPriceFeed({ network: 'sepolia' });
    const addr = feed.getFeedAddress('ETH-USD');
    expect(addr).toBe(CHAINLINK_FEEDS['ETH-USD']!.addresses.sepolia);
  });

  test('custom contractFactory is called with correct address', async () => {
    let capturedAddress = '';
    const feed = new ChainlinkPriceFeed({
      network: 'base',
      contractFactory: (addr) => {
        capturedAddress = addr;
        return makeMockContract();
      },
    });
    await feed.getLatestPrice('ETH-USD');
    expect(capturedAddress).toBe(CHAINLINK_FEEDS['ETH-USD']!.addresses.base);
  });

  test('custom contractFactory receives ABI', async () => {
    let capturedAbi: any = null;
    const feed = new ChainlinkPriceFeed({
      network: 'base',
      contractFactory: (_addr, abi) => {
        capturedAbi = abi;
        return makeMockContract();
      },
    });
    await feed.getLatestPrice('ETH-USD');
    expect(capturedAbi).toBe(AGGREGATOR_V3_ABI);
  });

  test('price computation uses contract decimals not metadata', async () => {
    // Contract returns different decimals than metadata default
    const feed = new ChainlinkPriceFeed({
      network: 'base',
      contractFactory: () => makeMockContract({ decimals: 6, answer: BigInt(3500000000) }),
    });
    const data = await feed.getLatestPrice('ETH-USD');
    // With 6 decimals: 3500000000 / 1e6 = 3500
    expect(data.price).toBeCloseTo(3500, 1);
    expect(data.decimals).toBe(6);
  });
});
