/**
 * Chainlink Data Feeds — Core Tests
 *
 * Tests:
 * - CHAINLINK_FEEDS metadata
 * - ChainlinkPriceFeed class with mocked contracts
 * - Price fetching, staleness, confidence scoring
 * - Hybrid alert creation and evaluation
 * - Oracle-market correlation
 * - Divergence detection
 * - TWAP computation
 * - Edge cases and error handling
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
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
  FeedMetadata,
  ChainlinkPriceData,
  PriceWithConfidence,
  HybridAlertConfig,
  HybridAlertEvaluation,
  OracleMarketCorrelation,
  OracleMarketDivergence,
  AggregatedPrice,
  IAggregatorV3,
} from '../chainlink-data-feeds';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const NOW_SEC = Math.floor(Date.now() / 1000);
const FRESH = NOW_SEC - 60;        // 1 minute ago
const SLIGHTLY_STALE = NOW_SEC - 4000; // ~67 min ago (> 1hr heartbeat)
const VERY_STALE = NOW_SEC - 86400;   // 24 hours ago

function makeMockContract(overrides: Partial<{
  decimals: number;
  answer: bigint;
  roundId: bigint;
  updatedAt: number;
  answeredInRound: bigint;
  throwOnLatestRound: boolean;
  throwOnDecimals: boolean;
}>  = {}): IAggregatorV3 {
  const {
    decimals = 8,
    answer = BigInt(350000000000),  // $3500.00 with 8 decimals
    roundId = BigInt(100),
    updatedAt = FRESH,
    answeredInRound = BigInt(100),
    throwOnLatestRound = false,
    throwOnDecimals = false,
  } = overrides;

  return {
    decimals: async () => {
      if (throwOnDecimals) throw new Error('decimals() failed');
      return decimals;
    },
    description: async () => 'ETH / USD',
    latestRoundData: async () => {
      if (throwOnLatestRound) throw new Error('latestRoundData() failed');
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

function makeFeed(feedId: string, overrides = {}) {
  return new ChainlinkPriceFeed({
    network: 'base',
    contractFactory: (_addr, _abi, _provider) => makeMockContract(overrides),
  });
}

// ─── CHAINLINK_FEEDS metadata ──────────────────────────────────────────────────

describe('CHAINLINK_FEEDS metadata', () => {
  test('has all 6 required feeds', () => {
    expect(CHAINLINK_FEEDS['ETH-USD']).toBeDefined();
    expect(CHAINLINK_FEEDS['BTC-USD']).toBeDefined();
    expect(CHAINLINK_FEEDS['LINK-USD']).toBeDefined();
    expect(CHAINLINK_FEEDS['MATIC-USD']).toBeDefined();
    expect(CHAINLINK_FEEDS['SOL-USD']).toBeDefined();
    expect(CHAINLINK_FEEDS['AVAX-USD']).toBeDefined();
  });

  test('ETH-USD has correct decimals', () => {
    expect(CHAINLINK_FEEDS['ETH-USD']!.decimals).toBe(8);
  });

  test('BTC-USD has correct decimals', () => {
    expect(CHAINLINK_FEEDS['BTC-USD']!.decimals).toBe(8);
  });

  test('all feeds have mainnet address', () => {
    for (const [id, feed] of Object.entries(CHAINLINK_FEEDS)) {
      expect(feed.addresses.mainnet, `${id} missing mainnet address`).toBeTruthy();
    }
  });

  test('ETH-USD has Base address', () => {
    expect(CHAINLINK_FEEDS['ETH-USD']!.addresses.base).toBeTruthy();
  });

  test('BTC-USD has Base address', () => {
    expect(CHAINLINK_FEEDS['BTC-USD']!.addresses.base).toBeTruthy();
  });

  test('all feeds have heartbeatSeconds', () => {
    for (const [id, feed] of Object.entries(CHAINLINK_FEEDS)) {
      expect(feed.heartbeatSeconds, `${id} missing heartbeatSeconds`).toBeGreaterThan(0);
    }
  });

  test('all feeds have category', () => {
    for (const feed of Object.values(CHAINLINK_FEEDS)) {
      expect(['crypto', 'forex', 'commodity']).toContain(feed.category);
    }
  });

  test('ETH-USD has testnet addresses', () => {
    expect(CHAINLINK_FEEDS['ETH-USD']!.addresses.sepolia).toBeTruthy();
    expect(CHAINLINK_FEEDS['ETH-USD']!.addresses.baseSepolia).toBeTruthy();
  });

  test('all crypto feeds have heartbeat of 3600 seconds', () => {
    for (const feed of Object.values(CHAINLINK_FEEDS)) {
      if (feed.category === 'crypto') {
        expect(feed.heartbeatSeconds).toBe(3600);
      }
    }
  });

  test('all feed ids match their map keys', () => {
    for (const [key, feed] of Object.entries(CHAINLINK_FEEDS)) {
      expect(feed.id).toBe(key);
    }
  });
});

// ─── AggregatorV3 ABI ─────────────────────────────────────────────────────────

describe('AGGREGATOR_V3_ABI', () => {
  test('has latestRoundData function', () => {
    const fn = AGGREGATOR_V3_ABI.find(e => e.name === 'latestRoundData');
    expect(fn).toBeDefined();
  });

  test('latestRoundData has 5 outputs', () => {
    const fn = AGGREGATOR_V3_ABI.find(e => e.name === 'latestRoundData')!;
    expect(fn.outputs).toHaveLength(5);
  });

  test('has decimals function', () => {
    const fn = AGGREGATOR_V3_ABI.find(e => e.name === 'decimals');
    expect(fn).toBeDefined();
  });

  test('has getRoundData function', () => {
    const fn = AGGREGATOR_V3_ABI.find(e => e.name === 'getRoundData');
    expect(fn).toBeDefined();
  });

  test('has description function', () => {
    const fn = AGGREGATOR_V3_ABI.find(e => e.name === 'description');
    expect(fn).toBeDefined();
  });
});

// ─── ChainlinkPriceFeed — getLatestPrice ──────────────────────────────────────

describe('ChainlinkPriceFeed.getLatestPrice', () => {
  test('returns price data for ETH-USD', async () => {
    const feed = makeFeed('ETH-USD');
    const data = await feed.getLatestPrice('ETH-USD');
    expect(data.feedId).toBe('ETH-USD');
    expect(data.price).toBeCloseTo(3500, 0);
    expect(data.decimals).toBe(8);
  });

  test('returns correct decimals', async () => {
    const feed = makeFeed('ETH-USD');
    const data = await feed.getLatestPrice('ETH-USD');
    expect(data.decimals).toBe(8);
  });

  test('returns roundId', async () => {
    const feed = makeFeed('ETH-USD');
    const data = await feed.getLatestPrice('ETH-USD');
    expect(data.roundId).toBe(BigInt(100));
  });

  test('returns updatedAt timestamp', async () => {
    const feed = makeFeed('ETH-USD');
    const data = await feed.getLatestPrice('ETH-USD');
    expect(data.updatedAt).toBe(FRESH);
  });

  test('returns answeredInRound', async () => {
    const feed = makeFeed('ETH-USD');
    const data = await feed.getLatestPrice('ETH-USD');
    expect(data.answeredInRound).toBe(BigInt(100));
  });

  test('returns rawPrice as bigint', async () => {
    const feed = makeFeed('ETH-USD');
    const data = await feed.getLatestPrice('ETH-USD');
    expect(typeof data.rawPrice).toBe('bigint');
  });

  test('throws for unknown feed', async () => {
    const feed = makeFeed('ETH-USD');
    await expect(feed.getLatestPrice('UNKNOWN-USD')).rejects.toThrow('Unknown feed');
  });

  test('throws when contract call fails', async () => {
    const feed = makeFeed('ETH-USD', { throwOnLatestRound: true });
    await expect(feed.getLatestPrice('ETH-USD')).rejects.toThrow('Failed to fetch price');
  });

  test('throws for invalid (zero) price', async () => {
    const feed = makeFeed('ETH-USD', { answer: BigInt(0) });
    await expect(feed.getLatestPrice('ETH-USD')).rejects.toThrow('Invalid price');
  });

  test('BTC price computation is correct', async () => {
    const feed = new ChainlinkPriceFeed({
      network: 'base',
      contractFactory: () => makeMockContract({ answer: BigInt(8000000000000), decimals: 8 }),
    });
    const data = await feed.getLatestPrice('BTC-USD');
    expect(data.price).toBeCloseTo(80000, 0);
  });

  test('throws on decimals failure', async () => {
    const feed = makeFeed('ETH-USD', { throwOnDecimals: true });
    await expect(feed.getLatestPrice('ETH-USD')).rejects.toThrow();
  });
});

// ─── ChainlinkPriceFeed — isFeedStale ─────────────────────────────────────────

describe('ChainlinkPriceFeed.isFeedStale', () => {
  test('fresh feed is not stale (1hr max age)', async () => {
    const feed = makeFeed('ETH-USD', { updatedAt: FRESH });
    const stale = await feed.isFeedStale('ETH-USD', 3600);
    expect(stale).toBe(false);
  });

  test('old feed is stale (1hr max age)', async () => {
    const feed = makeFeed('ETH-USD', { updatedAt: VERY_STALE });
    const stale = await feed.isFeedStale('ETH-USD', 3600);
    expect(stale).toBe(true);
  });

  test('slightly stale feed with 2hr window is not stale', async () => {
    const feed = makeFeed('ETH-USD', { updatedAt: SLIGHTLY_STALE });
    const stale = await feed.isFeedStale('ETH-USD', 7200);
    expect(stale).toBe(false);
  });

  test('returns true when fetch fails', async () => {
    const feed = makeFeed('ETH-USD', { throwOnLatestRound: true });
    const stale = await feed.isFeedStale('ETH-USD', 3600);
    expect(stale).toBe(true);
  });

  test('feed updated 30 min ago with 1hr window is not stale', async () => {
    const thirtyMinAgo = NOW_SEC - 1800;
    const feed = makeFeed('ETH-USD', { updatedAt: thirtyMinAgo });
    const stale = await feed.isFeedStale('ETH-USD', 3600);
    expect(stale).toBe(false);
  });
});

// ─── ChainlinkPriceFeed — getPriceWithConfidence ──────────────────────────────

describe('ChainlinkPriceFeed.getPriceWithConfidence', () => {
  test('fresh feed returns high confidence', async () => {
    const feed = makeFeed('ETH-USD', { updatedAt: FRESH });
    const data = await feed.getPriceWithConfidence('ETH-USD');
    expect(data.confidence).toBe('high');
  });

  test('stale feed returns stale confidence', async () => {
    const feed = makeFeed('ETH-USD', { updatedAt: VERY_STALE });
    const data = await feed.getPriceWithConfidence('ETH-USD');
    expect(data.confidence).toBe('stale');
  });

  test('incomplete round returns low confidence', async () => {
    const feed = makeFeed('ETH-USD', {
      updatedAt: FRESH,
      roundId: BigInt(200),
      answeredInRound: BigInt(100), // answeredInRound < roundId
    });
    const data = await feed.getPriceWithConfidence('ETH-USD');
    expect(data.confidence).toBe('low');
  });

  test('high confidence score is near 1.0', async () => {
    const feed = makeFeed('ETH-USD', { updatedAt: FRESH });
    const data = await feed.getPriceWithConfidence('ETH-USD');
    expect(data.confidenceScore).toBeGreaterThan(0.8);
  });

  test('stale confidence score is 0', async () => {
    const feed = makeFeed('ETH-USD', { updatedAt: VERY_STALE });
    const data = await feed.getPriceWithConfidence('ETH-USD');
    expect(data.confidenceScore).toBe(0);
  });

  test('returns staleness in seconds', async () => {
    const feed = makeFeed('ETH-USD', { updatedAt: FRESH });
    const data = await feed.getPriceWithConfidence('ETH-USD');
    expect(data.staleness).toBeGreaterThanOrEqual(0);
    expect(data.staleness).toBeLessThan(120); // should be ~60s
  });

  test('isStale is false for fresh feed', async () => {
    const feed = makeFeed('ETH-USD', { updatedAt: FRESH });
    const data = await feed.getPriceWithConfidence('ETH-USD');
    expect(data.isStale).toBe(false);
  });

  test('isStale is true for very old feed', async () => {
    const feed = makeFeed('ETH-USD', { updatedAt: VERY_STALE });
    const data = await feed.getPriceWithConfidence('ETH-USD');
    expect(data.isStale).toBe(true);
  });

  test('roundComplete is true when answeredInRound >= roundId', async () => {
    const feed = makeFeed('ETH-USD', { roundId: BigInt(100), answeredInRound: BigInt(100) });
    const data = await feed.getPriceWithConfidence('ETH-USD');
    expect(data.roundComplete).toBe(true);
  });

  test('roundComplete is false when answeredInRound < roundId', async () => {
    const feed = makeFeed('ETH-USD', { roundId: BigInt(200), answeredInRound: BigInt(100) });
    const data = await feed.getPriceWithConfidence('ETH-USD');
    expect(data.roundComplete).toBe(false);
  });
});

// ─── ChainlinkPriceFeed — getMultiplePrices ───────────────────────────────────

describe('ChainlinkPriceFeed.getMultiplePrices', () => {
  test('returns results for all valid feeds', async () => {
    const feed = new ChainlinkPriceFeed({
      network: 'base',
      contractFactory: () => makeMockContract(),
    });
    const { results, errors } = await feed.getMultiplePrices(['ETH-USD', 'BTC-USD']);
    expect(results).toHaveLength(2);
    expect(errors).toHaveLength(0);
  });

  test('collects errors for failed feeds', async () => {
    let callCount = 0;
    const feed = new ChainlinkPriceFeed({
      network: 'base',
      contractFactory: () => {
        callCount++;
        return makeMockContract({ throwOnLatestRound: callCount === 2 });
      },
    });
    const { results, errors } = await feed.getMultiplePrices(['ETH-USD', 'BTC-USD']);
    expect(results).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.feedId).toBe('BTC-USD');
  });

  test('returns empty arrays for empty input', async () => {
    const feed = makeFeed('ETH-USD');
    const { results, errors } = await feed.getMultiplePrices([]);
    expect(results).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  test('handles unknown feed ids in batch', async () => {
    const feed = makeFeed('ETH-USD');
    const { results, errors } = await feed.getMultiplePrices(['ETH-USD', 'UNKNOWN-XYZ']);
    expect(results).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  test('each result has feedId', async () => {
    const feed = new ChainlinkPriceFeed({
      network: 'base',
      contractFactory: () => makeMockContract(),
    });
    const { results } = await feed.getMultiplePrices(['ETH-USD']);
    expect(results[0]!.feedId).toBe('ETH-USD');
  });
});

// ─── getFeedAddress ───────────────────────────────────────────────────────────

describe('ChainlinkPriceFeed.getFeedAddress', () => {
  test('returns Base address for ETH-USD on base network', () => {
    const feed = new ChainlinkPriceFeed({ network: 'base' });
    const addr = feed.getFeedAddress('ETH-USD');
    expect(addr).toBe(CHAINLINK_FEEDS['ETH-USD']!.addresses.base);
  });

  test('returns mainnet address on mainnet', () => {
    const feed = new ChainlinkPriceFeed({ network: 'mainnet' });
    const addr = feed.getFeedAddress('ETH-USD');
    expect(addr).toBe(CHAINLINK_FEEDS['ETH-USD']!.addresses.mainnet);
  });

  test('throws for unknown feed', () => {
    const feed = new ChainlinkPriceFeed({ network: 'base' });
    expect(() => feed.getFeedAddress('FAKE-USD')).toThrow('Unknown feed');
  });

  test('throws when feed not on network', () => {
    const feed = new ChainlinkPriceFeed({ network: 'baseSepolia' });
    // SOL-USD has no baseSepolia address
    expect(() => feed.getFeedAddress('SOL-USD')).toThrow();
  });
});

// ─── createHybridAlert ────────────────────────────────────────────────────────

describe('createHybridAlert', () => {
  test('creates alert with basic config', () => {
    const alert = createHybridAlert({
      description: 'BTC > $80k AND ETF approval > 70%',
      oracleConditions: [{ feedId: 'BTC-USD', operator: 'gt', value: 80000 }],
      marketConditions: [{ marketId: 'm1', outcome: 'Yes', operator: 'gt', value: 70 }],
      notifyUrl: 'https://example.com/webhook',
    });
    expect(alert.description).toBe('BTC > $80k AND ETF approval > 70%');
    expect(alert.logic).toBe('AND');
    expect(alert.oracleConditions).toHaveLength(1);
    expect(alert.marketConditions).toHaveLength(1);
  });

  test('generates unique id if not provided', () => {
    const a1 = createHybridAlert({
      description: 'test',
      oracleConditions: [{ feedId: 'ETH-USD', operator: 'gt', value: 3000 }],
      marketConditions: [],
      notifyUrl: 'https://example.com',
    });
    const a2 = createHybridAlert({
      description: 'test',
      oracleConditions: [{ feedId: 'ETH-USD', operator: 'gt', value: 3000 }],
      marketConditions: [],
      notifyUrl: 'https://example.com',
    });
    expect(a1.id).not.toBe(a2.id);
  });

  test('uses provided id', () => {
    const alert = createHybridAlert({
      id: 'my-alert-123',
      description: 'test',
      oracleConditions: [{ feedId: 'ETH-USD', operator: 'gt', value: 3000 }],
      marketConditions: [],
      notifyUrl: 'https://example.com',
    });
    expect(alert.id).toBe('my-alert-123');
  });

  test('defaults logic to AND', () => {
    const alert = createHybridAlert({
      description: 'test',
      oracleConditions: [{ feedId: 'ETH-USD', operator: 'gt', value: 3000 }],
      marketConditions: [],
      notifyUrl: 'https://example.com',
    });
    expect(alert.logic).toBe('AND');
  });

  test('accepts OR logic', () => {
    const alert = createHybridAlert({
      description: 'test',
      oracleConditions: [{ feedId: 'ETH-USD', operator: 'gt', value: 3000 }],
      marketConditions: [],
      logic: 'OR',
      notifyUrl: 'https://example.com',
    });
    expect(alert.logic).toBe('OR');
  });

  test('throws for empty description', () => {
    expect(() =>
      createHybridAlert({
        description: '',
        oracleConditions: [{ feedId: 'ETH-USD', operator: 'gt', value: 3000 }],
        marketConditions: [],
        notifyUrl: 'https://example.com',
      })
    ).toThrow('description');
  });

  test('throws when no conditions provided', () => {
    expect(() =>
      createHybridAlert({
        description: 'test',
        oracleConditions: [],
        marketConditions: [],
        notifyUrl: 'https://example.com',
      })
    ).toThrow('condition');
  });

  test('throws for unknown feed in oracle condition', () => {
    expect(() =>
      createHybridAlert({
        description: 'test',
        oracleConditions: [{ feedId: 'FAKE-USD', operator: 'gt', value: 100 }],
        marketConditions: [],
        notifyUrl: 'https://example.com',
      })
    ).toThrow('FAKE-USD');
  });

  test('throws for market condition value > 100', () => {
    expect(() =>
      createHybridAlert({
        description: 'test',
        oracleConditions: [],
        marketConditions: [{ marketId: 'm1', outcome: 'Yes', operator: 'gt', value: 150 }],
        notifyUrl: 'https://example.com',
      })
    ).toThrow();
  });

  test('throws for negative market condition value', () => {
    expect(() =>
      createHybridAlert({
        description: 'test',
        oracleConditions: [],
        marketConditions: [{ marketId: 'm1', outcome: 'Yes', operator: 'gt', value: -5 }],
        notifyUrl: 'https://example.com',
      })
    ).toThrow();
  });

  test('throws for between oracle condition without valueUpper', () => {
    expect(() =>
      createHybridAlert({
        description: 'test',
        oracleConditions: [{ feedId: 'ETH-USD', operator: 'between', value: 3000 }],
        marketConditions: [],
        notifyUrl: 'https://example.com',
      })
    ).toThrow('valueUpper');
  });

  test('sets createdAt timestamp', () => {
    const before = Date.now();
    const alert = createHybridAlert({
      description: 'test',
      oracleConditions: [{ feedId: 'ETH-USD', operator: 'gt', value: 3000 }],
      marketConditions: [],
      notifyUrl: 'https://example.com',
    });
    expect(alert.createdAt).toBeGreaterThanOrEqual(before);
    expect(alert.createdAt).toBeLessThanOrEqual(Date.now());
  });

  test('trims description whitespace', () => {
    const alert = createHybridAlert({
      description: '  test alert  ',
      oracleConditions: [{ feedId: 'ETH-USD', operator: 'gt', value: 3000 }],
      marketConditions: [],
      notifyUrl: 'https://example.com',
    });
    expect(alert.description).toBe('test alert');
  });
});

// ─── evaluateHybridAlert ──────────────────────────────────────────────────────

describe('evaluateHybridAlert', () => {
  function makeAlert(
    logic: 'AND' | 'OR' = 'AND',
    oracleConds: any[] = [],
    marketConds: any[] = [],
  ): HybridAlertConfig {
    return {
      id: 'test-alert',
      description: 'test',
      oracleConditions: oracleConds,
      marketConditions: marketConds,
      logic,
      notifyUrl: 'https://example.com',
      createdAt: Date.now(),
    };
  }

  test('AND alert triggers when all conditions met', () => {
    const alert = makeAlert('AND',
      [{ feedId: 'BTC-USD', operator: 'gt', value: 80000 }],
      [{ marketId: 'm1', outcome: 'Yes', operator: 'gt', value: 70 }],
    );
    const result = evaluateHybridAlert(alert, { 'BTC-USD': 85000 }, { 'm1:Yes': 75 });
    expect(result.triggered).toBe(true);
  });

  test('AND alert does not trigger if oracle condition fails', () => {
    const alert = makeAlert('AND',
      [{ feedId: 'BTC-USD', operator: 'gt', value: 80000 }],
      [{ marketId: 'm1', outcome: 'Yes', operator: 'gt', value: 70 }],
    );
    const result = evaluateHybridAlert(alert, { 'BTC-USD': 75000 }, { 'm1:Yes': 75 });
    expect(result.triggered).toBe(false);
  });

  test('AND alert does not trigger if market condition fails', () => {
    const alert = makeAlert('AND',
      [{ feedId: 'BTC-USD', operator: 'gt', value: 80000 }],
      [{ marketId: 'm1', outcome: 'Yes', operator: 'gt', value: 70 }],
    );
    const result = evaluateHybridAlert(alert, { 'BTC-USD': 85000 }, { 'm1:Yes': 60 });
    expect(result.triggered).toBe(false);
  });

  test('OR alert triggers if only oracle condition met', () => {
    const alert = makeAlert('OR',
      [{ feedId: 'ETH-USD', operator: 'gt', value: 3000 }],
      [{ marketId: 'm1', outcome: 'Yes', operator: 'gt', value: 70 }],
    );
    const result = evaluateHybridAlert(alert, { 'ETH-USD': 4000 }, { 'm1:Yes': 60 });
    expect(result.triggered).toBe(true);
  });

  test('OR alert triggers if only market condition met', () => {
    const alert = makeAlert('OR',
      [{ feedId: 'ETH-USD', operator: 'gt', value: 3000 }],
      [{ marketId: 'm1', outcome: 'Yes', operator: 'gt', value: 70 }],
    );
    const result = evaluateHybridAlert(alert, { 'ETH-USD': 2000 }, { 'm1:Yes': 80 });
    expect(result.triggered).toBe(true);
  });

  test('OR alert does not trigger when both conditions fail', () => {
    const alert = makeAlert('OR',
      [{ feedId: 'ETH-USD', operator: 'gt', value: 3000 }],
      [{ marketId: 'm1', outcome: 'Yes', operator: 'gt', value: 70 }],
    );
    const result = evaluateHybridAlert(alert, { 'ETH-USD': 2000 }, { 'm1:Yes': 60 });
    expect(result.triggered).toBe(false);
  });

  test('lte operator works correctly', () => {
    const alert = makeAlert('AND',
      [{ feedId: 'ETH-USD', operator: 'lte', value: 3000 }],
      [],
    );
    expect(evaluateHybridAlert(alert, { 'ETH-USD': 3000 }, {}).triggered).toBe(true);
    expect(evaluateHybridAlert(alert, { 'ETH-USD': 3001 }, {}).triggered).toBe(false);
  });

  test('between operator works correctly', () => {
    const alert = makeAlert('AND',
      [{ feedId: 'ETH-USD', operator: 'between', value: 3000, valueUpper: 4000 }],
      [],
    );
    expect(evaluateHybridAlert(alert, { 'ETH-USD': 3500 }, {}).triggered).toBe(true);
    expect(evaluateHybridAlert(alert, { 'ETH-USD': 5000 }, {}).triggered).toBe(false);
  });

  test('returns oracle results with feed prices', () => {
    const alert = makeAlert('AND',
      [{ feedId: 'ETH-USD', operator: 'gt', value: 3000 }],
      [],
    );
    const result = evaluateHybridAlert(alert, { 'ETH-USD': 3500 }, {});
    expect(result.oracleResults[0]!.price).toBe(3500);
    expect(result.oracleResults[0]!.feedId).toBe('ETH-USD');
  });

  test('returns market results with probabilities', () => {
    const alert = makeAlert('AND', [], [
      { marketId: 'm1', outcome: 'Yes', operator: 'gt', value: 60 },
    ]);
    const result = evaluateHybridAlert(alert, {}, { 'm1:Yes': 75 });
    expect(result.marketResults[0]!.probability).toBe(75);
    expect(result.marketResults[0]!.marketId).toBe('m1');
  });

  test('missing oracle price results in condition not met', () => {
    const alert = makeAlert('AND',
      [{ feedId: 'ETH-USD', operator: 'gt', value: 3000 }],
      [],
    );
    const result = evaluateHybridAlert(alert, {}, {});
    expect(result.oracleResults[0]!.conditionMet).toBe(false);
  });

  test('sets evaluatedAt timestamp', () => {
    const before = Date.now();
    const alert = makeAlert('AND', [], [
      { marketId: 'm1', outcome: 'Yes', operator: 'gt', value: 50 },
    ]);
    const result = evaluateHybridAlert(alert, {}, { 'm1:Yes': 60 });
    expect(result.evaluatedAt).toBeGreaterThanOrEqual(before);
  });
});

// ─── correlateOracleWithMarket ─────────────────────────────────────────────────

describe('correlateOracleWithMarket', () => {
  const NOW = Date.now();
  const INTERVAL = 300000;

  function makeTimeSeries(values: number[], startTime = NOW - values.length * INTERVAL) {
    return values.map((price, i) => ({ price, timestamp: startTime + i * INTERVAL }));
  }

  test('returns correlation close to 1 for perfectly correlated series', () => {
    const prices = [100, 105, 110, 115, 120, 125, 130];
    const oracle = makeTimeSeries(prices.map(p => p * 30)); // ETH at 30x scale
    const market = makeTimeSeries(prices.map(p => p * 0.5)); // 50% to 65%
    const result = correlateOracleWithMarket(oracle, market, 'ETH-USD', 'm1');
    expect(result.correlation).toBeGreaterThan(0.95);
  });

  test('returns correlation close to -1 for inversely correlated series', () => {
    const oracle = makeTimeSeries([100, 105, 110, 115, 120].map(p => p * 30));
    const market = makeTimeSeries([120, 115, 110, 105, 100].map(p => p * 0.5));
    const result = correlateOracleWithMarket(oracle, market, 'ETH-USD', 'm1');
    expect(result.correlation).toBeLessThan(-0.95);
  });

  test('returns 0 for empty series', () => {
    const result = correlateOracleWithMarket([], [], 'ETH-USD', 'm1');
    expect(result.correlation).toBe(0);
    expect(result.dataPoints).toBe(0);
  });

  test('sets feedId and marketId', () => {
    const oracle = makeTimeSeries([3000, 3100, 3200]);
    const market = makeTimeSeries([50, 55, 60]);
    const result = correlateOracleWithMarket(oracle, market, 'ETH-USD', 'market-1');
    expect(result.feedId).toBe('ETH-USD');
    expect(result.marketId).toBe('market-1');
  });

  test('has interpretation field', () => {
    const oracle = makeTimeSeries([3000, 3100, 3200]);
    const market = makeTimeSeries([50, 55, 60]);
    const result = correlateOracleWithMarket(oracle, market, 'ETH-USD', 'm1');
    expect(result.interpretation).toBeTruthy();
    expect(typeof result.interpretation).toBe('string');
  });

  test('weak correlation has appropriate interpretation', () => {
    const oracle = makeTimeSeries([100, 101, 99, 102, 100]);
    const market = makeTimeSeries([50, 30, 70, 20, 80]);
    const result = correlateOracleWithMarket(oracle, market, 'ETH-USD', 'm1');
    expect(result.interpretation).toContain('correlation');
  });

  test('dataPoints equals number of aligned pairs', () => {
    const oracle = makeTimeSeries([100, 110, 120, 130, 140]);
    const market = makeTimeSeries([50, 55, 60, 65, 70]);
    const result = correlateOracleWithMarket(oracle, market, 'ETH-USD', 'm1');
    expect(result.dataPoints).toBeGreaterThan(0);
    expect(result.dataPoints).toBeLessThanOrEqual(5);
  });
});

// ─── detectOracleMarketDivergence ──────────────────────────────────────────────

describe('detectOracleMarketDivergence', () => {
  const NOW = Date.now();
  const INTERVAL = 300000;

  function makeTimeSeries(values: number[], startTime = NOW - values.length * INTERVAL) {
    return values.map((price, i) => ({ price, timestamp: startTime + i * INTERVAL }));
  }

  test('returns null when oracle and market are aligned', () => {
    // Both going up
    const oracle = makeTimeSeries([3000, 3100, 3200]);
    const market = makeTimeSeries([50, 55, 60]);
    const result = detectOracleMarketDivergence(oracle, market, 10, 'ETH-USD', 'm1');
    expect(result).toBeNull();
  });

  test('detects divergence when oracle up and market down', () => {
    const oracle = makeTimeSeries([3000, 3500, 4000]);    // strong up
    const market = makeTimeSeries([70, 50, 30]);          // strong down
    const result = detectOracleMarketDivergence(oracle, market, 5, 'ETH-USD', 'm1');
    expect(result).not.toBeNull();
    expect(result!.divergenceType).toBe('conflicting');
  });

  test('returns null for insufficient data', () => {
    const oracle = makeTimeSeries([3000, 3100]);
    const market = makeTimeSeries([50, 55]);
    const result = detectOracleMarketDivergence(oracle, market, 10, 'ETH-USD', 'm1');
    expect(result).toBeNull();
  });

  test('divergence score is above threshold when detected', () => {
    const oracle = makeTimeSeries([3000, 3500, 4000]);
    const market = makeTimeSeries([70, 50, 30]);
    const result = detectOracleMarketDivergence(oracle, market, 5, 'ETH-USD', 'm1');
    expect(result!.divergenceScore).toBeGreaterThanOrEqual(5);
  });

  test('includes description string', () => {
    const oracle = makeTimeSeries([3000, 3500, 4000]);
    const market = makeTimeSeries([70, 50, 30]);
    const result = detectOracleMarketDivergence(oracle, market, 5, 'ETH-USD', 'm1');
    expect(result!.description).toBeTruthy();
    expect(typeof result!.description).toBe('string');
  });

  test('sets feedId and marketId', () => {
    const oracle = makeTimeSeries([3000, 3500, 4000]);
    const market = makeTimeSeries([70, 50, 30]);
    const result = detectOracleMarketDivergence(oracle, market, 5, 'ETH-USD', 'my-market');
    expect(result!.feedId).toBe('ETH-USD');
    expect(result!.marketId).toBe('my-market');
  });
});

// ─── computeTWAP ──────────────────────────────────────────────────────────────

describe('computeTWAP', () => {
  const NOW = Date.now();

  test('returns 0 for empty array', () => {
    expect(computeTWAP([], 3600000)).toBe(0);
  });

  test('returns single price for single point', () => {
    const prices = [{ price: 3500, timestamp: NOW - 1000 }];
    expect(computeTWAP(prices, 3600000)).toBe(3500);
  });

  test('equal-duration segments give simple average', () => {
    const prices = [
      { price: 100, timestamp: NOW - 4000 },
      { price: 200, timestamp: NOW - 2000 },
      { price: 300, timestamp: NOW - 0 },
    ];
    const twap = computeTWAP(prices, 10000);
    // Segment 1: price=100, duration=2000ms
    // Segment 2: price=200, duration=2000ms
    // Final segment from last price to now: ~0ms (negligible)
    // Expected TWAP ≈ (100*2000 + 200*2000) / 4000 = 150
    expect(twap).toBeGreaterThan(100);
    expect(twap).toBeLessThan(250);
  });

  test('longer-duration prices have more weight', () => {
    const prices = [
      { price: 1000, timestamp: NOW - 10000 },  // holds for 9000ms
      { price: 5000, timestamp: NOW - 1000 },   // holds for ~1000ms
    ];
    const twap = computeTWAP(prices, 60000);
    // Expected: weighted more towards 1000
    expect(twap).toBeLessThan(2000);
  });

  test('prices outside window are excluded', () => {
    const prices = [
      { price: 10000, timestamp: NOW - 200000 }, // 200s ago, outside 1 min window
      { price: 3500, timestamp: NOW - 30000 },   // 30s ago, inside window
    ];
    const twap = computeTWAP(prices, 60000); // 1 min window
    // Should be mostly influenced by the 3500 price
    expect(twap).toBeGreaterThan(3400);
    expect(twap).toBeLessThan(3600);
  });

  test('uses last known price when all outside window', () => {
    const prices = [
      { price: 3500, timestamp: NOW - 3600000 * 2 }, // 2 hours ago
    ];
    const result = computeTWAP(prices, 3600000); // 1 hour window
    expect(result).toBe(3500);
  });
});

// ─── normalizePrice ────────────────────────────────────────────────────────────

describe('normalizePrice', () => {
  test('normalizes bigint with 8 decimals', () => {
    expect(normalizePrice(BigInt(350000000000), 8)).toBeCloseTo(3500, 2);
  });

  test('normalizes number with 8 decimals', () => {
    expect(normalizePrice(350000000000, 8)).toBeCloseTo(3500, 2);
  });

  test('normalizes with 18 decimals', () => {
    expect(normalizePrice(1e18, 18)).toBeCloseTo(1, 6);
  });

  test('handles zero', () => {
    expect(normalizePrice(0, 8)).toBe(0);
  });

  test('handles large BTC price', () => {
    const raw = BigInt(8000000000000); // $80000 with 8 decimals
    expect(normalizePrice(raw, 8)).toBeCloseTo(80000, 0);
  });
});

// ─── convertDecimals ──────────────────────────────────────────────────────────

describe('convertDecimals', () => {
  test('8 to 18 decimals multiplies by 1e10', () => {
    expect(convertDecimals(3500, 8, 18)).toBeCloseTo(3500 * 1e10, 0);
  });

  test('same decimals returns same value', () => {
    expect(convertDecimals(3500, 8, 8)).toBe(3500);
  });

  test('18 to 8 decimals divides by 1e10', () => {
    const val = 3500 * 1e10;
    expect(convertDecimals(val, 18, 8)).toBeCloseTo(3500, 0);
  });
});

// ─── pearsonCorrelation ────────────────────────────────────────────────────────

describe('pearsonCorrelation', () => {
  test('returns 1 for identical series', () => {
    const x = [1, 2, 3, 4, 5];
    expect(pearsonCorrelation(x, x)).toBeCloseTo(1, 5);
  });

  test('returns -1 for perfectly inversely correlated series', () => {
    const x = [1, 2, 3, 4, 5];
    const y = [5, 4, 3, 2, 1];
    expect(pearsonCorrelation(x, y)).toBeCloseTo(-1, 5);
  });

  test('returns 0 for constant series', () => {
    const x = [3, 3, 3, 3, 3];
    const y = [1, 2, 3, 4, 5];
    expect(pearsonCorrelation(x, y)).toBe(0);
  });

  test('returns 0 for single element', () => {
    expect(pearsonCorrelation([5], [5])).toBe(0);
  });

  test('returns 0 for empty arrays', () => {
    expect(pearsonCorrelation([], [])).toBe(0);
  });

  test('handles mismatched length arrays', () => {
    const x = [1, 2, 3, 4, 5];
    const y = [1, 2, 3];
    const result = pearsonCorrelation(x, y);
    expect(result).toBeGreaterThanOrEqual(-1);
    expect(result).toBeLessThanOrEqual(1);
  });

  test('result is clamped to [-1, 1]', () => {
    const x = [1, 2, 3, 4, 5];
    const y = [2, 4, 6, 8, 10];
    const result = pearsonCorrelation(x, y);
    expect(result).toBeGreaterThanOrEqual(-1);
    expect(result).toBeLessThanOrEqual(1);
  });
});

// ─── aggregateFeedData ─────────────────────────────────────────────────────────

describe('aggregateFeedData', () => {
  const NOW = Date.now();

  test('returns zeros for empty array', () => {
    const result = aggregateFeedData([]);
    expect(result.weightedAverage).toBe(0);
    expect(result.median).toBe(0);
    expect(result.spread).toBe(0);
  });

  test('single feed returns its price as avg and median', () => {
    const data = [{ feedId: 'ETH-USD', price: 3500, timestamp: NOW - 1000 }];
    const result = aggregateFeedData(data);
    expect(result.weightedAverage).toBe(3500);
    expect(result.median).toBe(3500);
  });

  test('equal prices have zero spread', () => {
    const data = [
      { feedId: 'ETH-USD', price: 3500, timestamp: NOW - 1000 },
      { feedId: 'BTC-USD', price: 3500, timestamp: NOW - 1000 },
    ];
    const result = aggregateFeedData(data);
    expect(result.spread).toBe(0);
  });

  test('median with even number of elements', () => {
    const data = [
      { feedId: 'ETH-USD', price: 100, timestamp: NOW - 1000 },
      { feedId: 'BTC-USD', price: 200, timestamp: NOW - 1000 },
      { feedId: 'LINK-USD', price: 300, timestamp: NOW - 1000 },
      { feedId: 'SOL-USD', price: 400, timestamp: NOW - 1000 },
    ];
    const result = aggregateFeedData(data);
    expect(result.median).toBe(250); // (200+300)/2
  });

  test('applies custom weights', () => {
    const data = [
      { feedId: 'ETH-USD', price: 100, timestamp: NOW - 1000 },
      { feedId: 'BTC-USD', price: 200, timestamp: NOW - 1000 },
    ];
    const weights = { 'ETH-USD': 3, 'BTC-USD': 1 };
    const result = aggregateFeedData(data, weights);
    // weighted avg = (100*3 + 200*1) / 4 = 125
    expect(result.weightedAverage).toBeCloseTo(125, 2);
  });

  test('spread is max - min', () => {
    const data = [
      { feedId: 'ETH-USD', price: 3400, timestamp: NOW - 1000 },
      { feedId: 'BTC-USD', price: 3600, timestamp: NOW - 1000 },
    ];
    const result = aggregateFeedData(data);
    expect(result.spread).toBeCloseTo(200, 2);
  });

  test('includes feedIds list', () => {
    const data = [
      { feedId: 'ETH-USD', price: 3500, timestamp: NOW - 1000 },
      { feedId: 'BTC-USD', price: 80000, timestamp: NOW - 1000 },
    ];
    const result = aggregateFeedData(data);
    expect(result.feedIds).toContain('ETH-USD');
    expect(result.feedIds).toContain('BTC-USD');
  });

  test('sets computedAt timestamp', () => {
    const before = Date.now();
    const data = [{ feedId: 'ETH-USD', price: 3500, timestamp: NOW - 1000 }];
    const result = aggregateFeedData(data);
    expect(result.computedAt).toBeGreaterThanOrEqual(before);
  });
});
