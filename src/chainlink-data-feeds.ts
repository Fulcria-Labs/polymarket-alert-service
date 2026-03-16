/**
 * Chainlink Data Feeds Integration
 *
 * Integrates Chainlink Price Feeds (Data Feeds) to enrich prediction market
 * monitoring with on-chain oracle prices. This module provides:
 *
 * 1. AggregatorV3Interface — Chainlink's standard price feed ABI
 * 2. CHAINLINK_FEEDS — Map of popular feed pairs with mainnet/Base addresses
 * 3. ChainlinkPriceFeed — Class for reading and validating oracle data
 * 4. HybridAlert — Combine oracle prices with prediction market conditions
 * 5. Oracle-Market Correlation & Divergence Detection
 * 6. Price Aggregation utilities (weighted avg, median, TWAP)
 *
 * Built for the Chainlink Convergence Hackathon 2026.
 * Integrates with the CRE-powered Polymarket Alert workflow.
 */

// ─── ABI & Contract Interface ─────────────────────────────────────────────────

/** Minimal AggregatorV3Interface ABI for Chainlink price feeds */
export const AGGREGATOR_V3_ABI = [
  {
    inputs: [],
    name: 'decimals',
    outputs: [{ internalType: 'uint8', name: '', type: 'uint8' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'description',
    outputs: [{ internalType: 'string', name: '', type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'latestRoundData',
    outputs: [
      { internalType: 'uint80', name: 'roundId', type: 'uint80' },
      { internalType: 'int256', name: 'answer', type: 'int256' },
      { internalType: 'uint256', name: 'startedAt', type: 'uint256' },
      { internalType: 'uint256', name: 'updatedAt', type: 'uint256' },
      { internalType: 'uint80', name: 'answeredInRound', type: 'uint80' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint80', name: '_roundId', type: 'uint80' }],
    name: 'getRoundData',
    outputs: [
      { internalType: 'uint80', name: 'roundId', type: 'uint80' },
      { internalType: 'int256', name: 'answer', type: 'int256' },
      { internalType: 'uint256', name: 'startedAt', type: 'uint256' },
      { internalType: 'uint256', name: 'updatedAt', type: 'uint256' },
      { internalType: 'uint80', name: 'answeredInRound', type: 'uint80' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

// ─── Feed Metadata ─────────────────────────────────────────────────────────────

/** Metadata for a single Chainlink price feed */
export interface FeedMetadata {
  id: string;              // e.g. "ETH-USD"
  description: string;     // Human-readable description
  decimals: number;        // Oracle decimals (typically 8)
  addresses: {
    mainnet?: string;      // Ethereum mainnet
    base?: string;         // Base L2
    sepolia?: string;      // Sepolia testnet
    baseSepolia?: string;  // Base Sepolia testnet
  };
  category: 'crypto' | 'forex' | 'commodity';
  heartbeatSeconds: number; // Expected update frequency
}

/** Map of supported Chainlink price feeds */
export const CHAINLINK_FEEDS: Record<string, FeedMetadata> = {
  'ETH-USD': {
    id: 'ETH-USD',
    description: 'Ethereum / US Dollar',
    decimals: 8,
    addresses: {
      mainnet: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
      base: '0x71041dddad3595F9CEd3dCCFBe3D1F4b0a16Bb70',
      sepolia: '0x694AA1769357215DE4FAC081bf1f309aDC325306',
      baseSepolia: '0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1',
    },
    category: 'crypto',
    heartbeatSeconds: 3600,
  },
  'BTC-USD': {
    id: 'BTC-USD',
    description: 'Bitcoin / US Dollar',
    decimals: 8,
    addresses: {
      mainnet: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c',
      base: '0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F',
      sepolia: '0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43',
      baseSepolia: '0x0FB99723Aee6f420beAD13e6bBB79b7E6F034298',
    },
    category: 'crypto',
    heartbeatSeconds: 3600,
  },
  'LINK-USD': {
    id: 'LINK-USD',
    description: 'Chainlink Token / US Dollar',
    decimals: 8,
    addresses: {
      mainnet: '0x2c1d072e956AFFC0D435Cb7AC308d97e0F2c8c3',
      base: '0x17CAb8FE31E32f08326e5E27412894e49B0f9D65',
      sepolia: '0xc59E3633BAAC79493d908e63626716e204A45EdF',
      baseSepolia: '0xb113F5A928BCfb189C95bCE93480D8Cb72D35B31',
    },
    category: 'crypto',
    heartbeatSeconds: 3600,
  },
  'MATIC-USD': {
    id: 'MATIC-USD',
    description: 'Polygon / US Dollar',
    decimals: 8,
    addresses: {
      mainnet: '0x7bAC85A8a13A4BcD8abb3eB7d6b4d632c895f5D7',
      base: '0x7D4D2CAE2cBf25D9F42Ffb17d34e9DF6C2E63F8D',
      sepolia: '0x001382149eBa3441043c1c66972b4772963f5D43',
    },
    category: 'crypto',
    heartbeatSeconds: 3600,
  },
  'SOL-USD': {
    id: 'SOL-USD',
    description: 'Solana / US Dollar',
    decimals: 8,
    addresses: {
      mainnet: '0x4ffC43a60e009B551865A93d232E33Fce9f01507',
      base: '0x975043adBb80fc32276CbF9Bbcfd4A601a12462D',
    },
    category: 'crypto',
    heartbeatSeconds: 3600,
  },
  'AVAX-USD': {
    id: 'AVAX-USD',
    description: 'Avalanche / US Dollar',
    decimals: 8,
    addresses: {
      mainnet: '0xFF3EEb22B5E3dE6e705b44749C2559d704923FD7',
      base: '0xe31A73E0ABCFa70F578A07354c4Ab9a58Cf5bEa9',
    },
    category: 'crypto',
    heartbeatSeconds: 3600,
  },
};

// ─── Price Data Types ─────────────────────────────────────────────────────────

/** Raw price data from a Chainlink feed */
export interface ChainlinkPriceData {
  feedId: string;
  price: number;           // Price in USD (human-readable)
  rawPrice: bigint;        // Raw price from contract (before decimal scaling)
  decimals: number;        // Decimal places in raw price
  roundId: bigint;
  updatedAt: number;       // Unix timestamp in seconds
  answeredInRound: bigint;
}

/** Price data enriched with confidence metrics */
export interface PriceWithConfidence extends ChainlinkPriceData {
  confidence: 'high' | 'medium' | 'low' | 'stale';
  staleness: number;       // Seconds since last update
  isStale: boolean;
  roundComplete: boolean;  // answeredInRound >= roundId
  confidenceScore: number; // 0-1 numeric confidence
}

/** Aggregated price from multiple feeds */
export interface AggregatedPrice {
  feedIds: string[];
  weightedAverage: number;
  median: number;
  twap: number;
  min: number;
  max: number;
  spread: number;          // max - min
  computedAt: number;
}

// ─── Hybrid Alert Types ────────────────────────────────────────────────────────

/** Condition for oracle price */
export interface OracleCondition {
  feedId: string;
  operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'between';
  value: number;           // Price threshold in USD
  valueUpper?: number;     // Upper bound for 'between'
}

/** Condition for prediction market odds */
export interface MarketCondition {
  marketId: string;
  outcome: string;         // "Yes" or "No"
  operator: 'gt' | 'gte' | 'lt' | 'lte' | 'between';
  value: number;           // Probability threshold (0-100)
  valueUpper?: number;     // Upper bound for 'between'
}

/** Hybrid alert combining oracle price with market conditions */
export interface HybridAlertConfig {
  id: string;
  description: string;
  oracleConditions: OracleCondition[];   // All must be satisfied
  marketConditions: MarketCondition[];   // All must be satisfied
  logic: 'AND' | 'OR';                  // How to combine oracle + market
  notifyUrl: string;
  timeWindowMs?: number;                 // Optional time window for conditions
  createdAt: number;
}

/** Result of evaluating a hybrid alert */
export interface HybridAlertEvaluation {
  alertId: string;
  triggered: boolean;
  oracleResults: {
    feedId: string;
    price: number;
    conditionMet: boolean;
  }[];
  marketResults: {
    marketId: string;
    outcome: string;
    probability: number;
    conditionMet: boolean;
  }[];
  evaluatedAt: number;
}

// ─── Correlation Types ─────────────────────────────────────────────────────────

/** Result of oracle-market correlation */
export interface OracleMarketCorrelation {
  feedId: string;
  marketId: string;
  outcome: string;
  correlation: number;     // Pearson -1 to 1
  dataPoints: number;
  interpretation: string;
}

/** Oracle-market divergence signal */
export interface OracleMarketDivergence {
  feedId: string;
  marketId: string;
  outcome: string;
  divergenceScore: number; // 0-100, higher = more divergent
  oracleTrend: 'up' | 'down' | 'flat';
  marketTrend: 'up' | 'down' | 'flat';
  divergenceType: 'oracle_leading' | 'market_leading' | 'conflicting';
  description: string;
}

// ─── Mock Contract Interface ───────────────────────────────────────────────────

/**
 * Interface for the AggregatorV3 contract.
 * In production this would be an ethers.js Contract instance.
 */
export interface IAggregatorV3 {
  decimals(): Promise<number>;
  description(): Promise<string>;
  latestRoundData(): Promise<{
    roundId: bigint;
    answer: bigint;
    startedAt: bigint;
    updatedAt: bigint;
    answeredInRound: bigint;
  }>;
}

// ─── ChainlinkPriceFeed Class ──────────────────────────────────────────────────

export class ChainlinkPriceFeed {
  private network: 'mainnet' | 'base' | 'sepolia' | 'baseSepolia';
  private contractFactory: (address: string, abi: readonly any[], provider?: any) => IAggregatorV3;
  private provider: any;

  constructor(options: {
    network?: 'mainnet' | 'base' | 'sepolia' | 'baseSepolia';
    provider?: any;
    contractFactory?: (address: string, abi: readonly any[], provider?: any) => IAggregatorV3;
  } = {}) {
    this.network = options.network ?? 'base';
    this.provider = options.provider;
    this.contractFactory = options.contractFactory ?? this._defaultContractFactory;
  }

  private _defaultContractFactory(address: string, _abi: readonly any[], provider?: any): IAggregatorV3 {
    // In production, this creates an ethers.js Contract:
    // return new ethers.Contract(address, abi, provider) as unknown as IAggregatorV3;
    throw new Error(`No provider configured. Cannot create contract for ${address}`);
  }

  /** Get the contract address for a feed on the configured network */
  getFeedAddress(feedId: string): string {
    const feed = CHAINLINK_FEEDS[feedId];
    if (!feed) throw new Error(`Unknown feed: ${feedId}`);

    const address = feed.addresses[this.network];
    if (!address) throw new Error(`Feed ${feedId} not available on ${this.network}`);

    return address;
  }

  /** Get the contract instance for a feed */
  private getContract(feedId: string): IAggregatorV3 {
    const address = this.getFeedAddress(feedId);
    return this.contractFactory(address, AGGREGATOR_V3_ABI, this.provider);
  }

  /**
   * Get latest price from a Chainlink feed.
   * Returns price in human-readable USD (e.g., 3500.42 for ETH/USD).
   */
  async getLatestPrice(feedId: string): Promise<ChainlinkPriceData> {
    const feed = CHAINLINK_FEEDS[feedId];
    if (!feed) throw new Error(`Unknown feed: ${feedId}`);

    const contract = this.getContract(feedId);

    let decimals: number;
    let roundData: Awaited<ReturnType<IAggregatorV3['latestRoundData']>>;

    try {
      [decimals, roundData] = await Promise.all([
        contract.decimals(),
        contract.latestRoundData(),
      ]);
    } catch (err: any) {
      throw new Error(`Failed to fetch price for ${feedId}: ${err.message}`);
    }

    const rawPrice = roundData.answer;
    const price = Number(rawPrice) / Math.pow(10, decimals);

    if (price <= 0) {
      throw new Error(`Invalid price for ${feedId}: ${price}`);
    }

    return {
      feedId,
      price,
      rawPrice,
      decimals,
      roundId: roundData.roundId,
      updatedAt: Number(roundData.updatedAt),
      answeredInRound: roundData.answeredInRound,
    };
  }

  /**
   * Check if a feed's data is stale (older than maxAgeSeconds).
   */
  async isFeedStale(feedId: string, maxAgeSeconds: number): Promise<boolean> {
    try {
      const data = await this.getLatestPrice(feedId);
      const ageSeconds = Math.floor(Date.now() / 1000) - data.updatedAt;
      return ageSeconds > maxAgeSeconds;
    } catch {
      return true; // If we can't fetch, treat as stale
    }
  }

  /**
   * Get price with confidence level based on staleness and round completeness.
   */
  async getPriceWithConfidence(feedId: string): Promise<PriceWithConfidence> {
    const feed = CHAINLINK_FEEDS[feedId];
    if (!feed) throw new Error(`Unknown feed: ${feedId}`);

    const data = await this.getLatestPrice(feedId);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const staleness = nowSeconds - data.updatedAt;
    const isStale = staleness > feed.heartbeatSeconds * 2;
    const roundComplete = data.answeredInRound >= data.roundId;

    let confidence: PriceWithConfidence['confidence'];
    let confidenceScore: number;

    if (isStale) {
      confidence = 'stale';
      confidenceScore = 0;
    } else if (!roundComplete) {
      confidence = 'low';
      confidenceScore = 0.3;
    } else if (staleness > feed.heartbeatSeconds) {
      confidence = 'medium';
      confidenceScore = 0.6;
    } else {
      confidence = 'high';
      confidenceScore = 1.0;
    }

    // Interpolate score based on freshness
    if (confidence !== 'stale') {
      const freshnessRatio = Math.max(0, 1 - staleness / (feed.heartbeatSeconds * 2));
      confidenceScore = Math.min(confidenceScore, freshnessRatio + 0.1);
    }

    return {
      ...data,
      confidence,
      staleness,
      isStale,
      roundComplete,
      confidenceScore: parseFloat(confidenceScore.toFixed(3)),
    };
  }

  /**
   * Batch fetch multiple feeds concurrently.
   * Failed feeds are skipped and logged to errors array.
   */
  async getMultiplePrices(feedIds: string[]): Promise<{
    results: ChainlinkPriceData[];
    errors: { feedId: string; error: string }[];
  }> {
    const settled = await Promise.allSettled(
      feedIds.map(id => this.getLatestPrice(id))
    );

    const results: ChainlinkPriceData[] = [];
    const errors: { feedId: string; error: string }[] = [];

    for (let i = 0; i < settled.length; i++) {
      const result = settled[i]!;
      if (result.status === 'fulfilled') {
        results.push(result.value);
      } else {
        errors.push({
          feedId: feedIds[i]!,
          error: result.reason?.message ?? String(result.reason),
        });
      }
    }

    return { results, errors };
  }
}

// ─── Hybrid Alert Functions ────────────────────────────────────────────────────

/**
 * Create a hybrid alert that combines oracle price conditions with
 * prediction market probability conditions.
 *
 * Example: "Alert when BTC > $80,000 AND Bitcoin ETF approval > 70%"
 */
export function createHybridAlert(config: {
  id?: string;
  description: string;
  oracleConditions: OracleCondition[];
  marketConditions: MarketCondition[];
  logic?: 'AND' | 'OR';
  notifyUrl: string;
  timeWindowMs?: number;
}): HybridAlertConfig {
  if (!config.description || config.description.trim().length === 0) {
    throw new Error('Hybrid alert description is required');
  }

  if (config.oracleConditions.length === 0 && config.marketConditions.length === 0) {
    throw new Error('At least one oracle or market condition is required');
  }

  // Validate oracle conditions
  for (const cond of config.oracleConditions) {
    if (!CHAINLINK_FEEDS[cond.feedId]) {
      throw new Error(`Unknown oracle feed: ${cond.feedId}`);
    }
    if (cond.operator === 'between' && cond.valueUpper === undefined) {
      throw new Error(`Oracle condition 'between' requires valueUpper for feed ${cond.feedId}`);
    }
    if (cond.value < 0) {
      throw new Error(`Oracle condition value must be non-negative for feed ${cond.feedId}`);
    }
  }

  // Validate market conditions
  for (const cond of config.marketConditions) {
    if (cond.value < 0 || cond.value > 100) {
      throw new Error(`Market condition value must be 0-100 for market ${cond.marketId}`);
    }
    if (cond.operator === 'between' && cond.valueUpper === undefined) {
      throw new Error(`Market condition 'between' requires valueUpper for market ${cond.marketId}`);
    }
  }

  return {
    id: config.id ?? `hybrid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    description: config.description.trim(),
    oracleConditions: config.oracleConditions,
    marketConditions: config.marketConditions,
    logic: config.logic ?? 'AND',
    notifyUrl: config.notifyUrl,
    timeWindowMs: config.timeWindowMs,
    createdAt: Date.now(),
  };
}

/**
 * Evaluate whether a hybrid alert's conditions are currently met.
 *
 * @param alert The hybrid alert config
 * @param oraclePrices Map of feedId -> current price
 * @param marketProbabilities Map of `${marketId}:${outcome}` -> probability (0-100)
 */
export function evaluateHybridAlert(
  alert: HybridAlertConfig,
  oraclePrices: Record<string, number>,
  marketProbabilities: Record<string, number>,
): HybridAlertEvaluation {
  const oracleResults: HybridAlertEvaluation['oracleResults'] = [];
  const marketResults: HybridAlertEvaluation['marketResults'] = [];

  // Evaluate oracle conditions
  for (const cond of alert.oracleConditions) {
    const price = oraclePrices[cond.feedId];
    let conditionMet = false;

    if (price !== undefined) {
      conditionMet = evaluateCondition(price, cond.operator, cond.value, cond.valueUpper);
    }

    oracleResults.push({
      feedId: cond.feedId,
      price: price ?? 0,
      conditionMet,
    });
  }

  // Evaluate market conditions
  for (const cond of alert.marketConditions) {
    const key = `${cond.marketId}:${cond.outcome}`;
    const probability = marketProbabilities[key];
    let conditionMet = false;

    if (probability !== undefined) {
      conditionMet = evaluateCondition(probability, cond.operator, cond.value, cond.valueUpper);
    }

    marketResults.push({
      marketId: cond.marketId,
      outcome: cond.outcome,
      probability: probability ?? 0,
      conditionMet,
    });
  }

  // Combine results based on logic
  const allResults = [
    ...oracleResults.map(r => r.conditionMet),
    ...marketResults.map(r => r.conditionMet),
  ];

  let triggered: boolean;
  if (alert.logic === 'OR') {
    triggered = allResults.some(Boolean);
  } else {
    // AND logic (default): all conditions must be met
    triggered = allResults.length > 0 && allResults.every(Boolean);
  }

  return {
    alertId: alert.id,
    triggered,
    oracleResults,
    marketResults,
    evaluatedAt: Date.now(),
  };
}

/** Evaluate a single condition: value op threshold */
function evaluateCondition(
  value: number,
  operator: string,
  threshold: number,
  thresholdUpper?: number,
): boolean {
  switch (operator) {
    case 'gt': return value > threshold;
    case 'gte': return value >= threshold;
    case 'lt': return value < threshold;
    case 'lte': return value <= threshold;
    case 'eq': return Math.abs(value - threshold) < 0.0001;
    case 'between':
      return thresholdUpper !== undefined
        ? value >= threshold && value <= thresholdUpper
        : false;
    default: return false;
  }
}

// ─── Oracle-Market Correlation ─────────────────────────────────────────────────

/**
 * Compute Pearson correlation between oracle price changes and market odds changes.
 *
 * @param oraclePrices Array of {price, timestamp} from oracle
 * @param marketPrices Array of {price, timestamp} from prediction market (0-100 scale)
 */
export function correlateOracleWithMarket(
  oraclePrices: { price: number; timestamp: number }[],
  marketPrices: { price: number; timestamp: number }[],
  feedId: string = 'unknown',
  marketId: string = 'unknown',
  outcome: string = 'Yes',
): OracleMarketCorrelation {
  // Align series by timestamp (nearest-neighbor, 5 min tolerance)
  const aligned = alignTimeSeries(oraclePrices, marketPrices, 300000);

  const correlation = aligned.length >= 3
    ? pearsonCorrelation(aligned.map(p => p.a), aligned.map(p => p.b))
    : 0;

  let interpretation: string;
  if (Math.abs(correlation) < 0.2) {
    interpretation = 'No meaningful correlation between oracle price and market odds';
  } else if (correlation > 0.7) {
    interpretation = 'Strong positive correlation: market odds closely follow oracle price';
  } else if (correlation > 0.4) {
    interpretation = 'Moderate positive correlation: oracle price and market odds move together';
  } else if (correlation < -0.7) {
    interpretation = 'Strong negative correlation: market odds move opposite to oracle price';
  } else if (correlation < -0.4) {
    interpretation = 'Moderate negative correlation: market odds partially inverse oracle price';
  } else if (correlation > 0) {
    interpretation = 'Weak positive correlation';
  } else {
    interpretation = 'Weak negative correlation';
  }

  return {
    feedId,
    marketId,
    outcome,
    correlation: parseFloat(correlation.toFixed(4)),
    dataPoints: aligned.length,
    interpretation,
  };
}

/**
 * Detect when oracle prices and market odds are diverging significantly.
 * Useful for identifying mispricings or information gaps.
 *
 * @param threshold Minimum divergence score (0-100) to trigger
 */
export function detectOracleMarketDivergence(
  oraclePrices: { price: number; timestamp: number }[],
  marketPrices: { price: number; timestamp: number }[],
  threshold: number = 20,
  feedId: string = 'unknown',
  marketId: string = 'unknown',
  outcome: string = 'Yes',
): OracleMarketDivergence | null {
  if (oraclePrices.length < 3 || marketPrices.length < 3) return null;

  // Compute recent trends (last 3 data points)
  const recentOracle = oraclePrices.slice(-3).map(p => p.price);
  const recentMarket = marketPrices.slice(-3).map(p => p.price);

  const oracleTrend = computeTrend(recentOracle);
  const marketTrend = computeTrend(recentMarket);

  // Divergence when trends conflict
  const isTrendConflict =
    (oracleTrend === 'up' && marketTrend === 'down') ||
    (oracleTrend === 'down' && marketTrend === 'up');

  // Compute magnitude of divergence
  const oracleChange = percentChange(recentOracle[0]!, recentOracle[recentOracle.length - 1]!);
  const marketChange = percentChange(recentMarket[0]!, recentMarket[recentMarket.length - 1]!);

  // Divergence score: large when they move in opposite directions
  const divergenceScore = isTrendConflict
    ? Math.min(100, Math.abs(oracleChange) + Math.abs(marketChange))
    : Math.max(0, Math.abs(oracleChange) - Math.abs(marketChange) * 0.5);

  if (divergenceScore < threshold) return null;

  // Determine which is leading
  let divergenceType: OracleMarketDivergence['divergenceType'];
  if (isTrendConflict) {
    divergenceType = 'conflicting';
  } else if (Math.abs(oracleChange) > Math.abs(marketChange)) {
    divergenceType = 'oracle_leading';
  } else {
    divergenceType = 'market_leading';
  }

  const description = `Oracle ${oracleTrend} (${oracleChange > 0 ? '+' : ''}${oracleChange.toFixed(1)}%) ` +
    `while market odds ${marketTrend} (${marketChange > 0 ? '+' : ''}${marketChange.toFixed(1)}%). ` +
    `Divergence type: ${divergenceType.replace('_', ' ')}.`;

  return {
    feedId,
    marketId,
    outcome,
    divergenceScore: parseFloat(divergenceScore.toFixed(2)),
    oracleTrend,
    marketTrend,
    divergenceType,
    description,
  };
}

// ─── Price Aggregation ─────────────────────────────────────────────────────────

/**
 * Compute weighted average, median, and TWAP from multiple feed prices.
 *
 * @param feedData Array of {feedId, price, timestamp} entries
 * @param weights Optional map of feedId -> weight (defaults to equal weights)
 */
export function aggregateFeedData(
  feedData: { feedId: string; price: number; timestamp: number }[],
  weights?: Record<string, number>,
  twapWindowMs: number = 3600000,
): AggregatedPrice {
  if (feedData.length === 0) {
    return {
      feedIds: [],
      weightedAverage: 0,
      median: 0,
      twap: 0,
      min: 0,
      max: 0,
      spread: 0,
      computedAt: Date.now(),
    };
  }

  const feedIds = feedData.map(d => d.feedId);
  const prices = feedData.map(d => d.price);

  // Weighted average
  let weightedAverage: number;
  if (weights) {
    let totalWeight = 0;
    let weightedSum = 0;
    for (const d of feedData) {
      const w = weights[d.feedId] ?? 1;
      weightedSum += d.price * w;
      totalWeight += w;
    }
    weightedAverage = totalWeight > 0 ? weightedSum / totalWeight : 0;
  } else {
    weightedAverage = prices.reduce((a, b) => a + b, 0) / prices.length;
  }

  // Median
  const sorted = [...prices].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;

  // TWAP
  const pricesWithTime = feedData.map(d => ({ price: d.price, timestamp: d.timestamp }));
  const twap = computeTWAP(pricesWithTime, twapWindowMs);

  const min = Math.min(...prices);
  const max = Math.max(...prices);

  return {
    feedIds,
    weightedAverage: parseFloat(weightedAverage.toFixed(6)),
    median: parseFloat(median.toFixed(6)),
    twap: parseFloat(twap.toFixed(6)),
    min,
    max,
    spread: parseFloat((max - min).toFixed(6)),
    computedAt: Date.now(),
  };
}

/**
 * Compute Time-Weighted Average Price (TWAP) from a price series.
 * Each price is weighted by the duration it was the active price.
 *
 * @param prices Array of {price, timestamp} sorted by timestamp
 * @param windowMs Time window to consider (ms). Only prices within the window are used.
 */
export function computeTWAP(
  prices: { price: number; timestamp: number }[],
  windowMs: number = 3600000,
): number {
  if (prices.length === 0) return 0;
  if (prices.length === 1) return prices[0]!.price;

  const now = Date.now();
  const windowStart = now - windowMs;

  // Filter to window
  const relevant = prices
    .filter(p => p.timestamp >= windowStart)
    .sort((a, b) => a.timestamp - b.timestamp);

  if (relevant.length === 0) {
    // All prices are outside the window; use last known price
    const last = prices[prices.length - 1];
    return last ? last.price : 0;
  }

  if (relevant.length === 1) {
    return relevant[0]!.price;
  }

  // Compute time-weighted average: each segment weighted by its duration
  let totalWeight = 0;
  let weightedSum = 0;

  for (let i = 0; i < relevant.length - 1; i++) {
    const duration = relevant[i + 1]!.timestamp - relevant[i]!.timestamp;
    if (duration > 0) {
      weightedSum += relevant[i]!.price * duration;
      totalWeight += duration;
    }
  }

  // Add weight for the last segment (from last price to now or window end)
  const lastSegmentDuration = Math.min(now, windowStart + windowMs) - relevant[relevant.length - 1]!.timestamp;
  if (lastSegmentDuration > 0) {
    weightedSum += relevant[relevant.length - 1]!.price * lastSegmentDuration;
    totalWeight += lastSegmentDuration;
  }

  return totalWeight > 0 ? weightedSum / totalWeight : relevant[relevant.length - 1]!.price;
}

/**
 * Normalize a price to 8 decimal precision (standard Chainlink format).
 */
export function normalizePrice(rawPrice: bigint | number, decimals: number): number {
  const raw = typeof rawPrice === 'bigint' ? Number(rawPrice) : rawPrice;
  return raw / Math.pow(10, decimals);
}

/**
 * Convert a price to a different decimal precision.
 * e.g., convert 8-decimal price to 18-decimal for ERC-20 operations.
 */
export function convertDecimals(
  price: number,
  fromDecimals: number,
  toDecimals: number,
): number {
  if (fromDecimals === toDecimals) return price;
  const factor = Math.pow(10, toDecimals - fromDecimals);
  return price * factor;
}

// ─── Utility Functions ─────────────────────────────────────────────────────────

/** Compute Pearson correlation coefficient between two arrays */
export function pearsonCorrelation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 2) return 0;

  const xSlice = x.slice(0, n);
  const ySlice = y.slice(0, n);

  const xMean = xSlice.reduce((a, b) => a + b, 0) / n;
  const yMean = ySlice.reduce((a, b) => a + b, 0) / n;

  let numerator = 0;
  let xVariance = 0;
  let yVariance = 0;

  for (let i = 0; i < n; i++) {
    const dx = xSlice[i]! - xMean;
    const dy = ySlice[i]! - yMean;
    numerator += dx * dy;
    xVariance += dx * dx;
    yVariance += dy * dy;
  }

  const denominator = Math.sqrt(xVariance * yVariance);
  if (denominator === 0) return 0;

  return Math.max(-1, Math.min(1, numerator / denominator));
}

/** Align two time series by timestamp, returning only overlapping points */
function alignTimeSeries(
  seriesA: { price: number; timestamp: number }[],
  seriesB: { price: number; timestamp: number }[],
  toleranceMs: number = 300000,
): { a: number; b: number; timestamp: number }[] {
  const result: { a: number; b: number; timestamp: number }[] = [];
  let j = 0;

  for (const pointA of seriesA) {
    // Find closest match in seriesB
    while (
      j < seriesB.length - 1 &&
      Math.abs(seriesB[j + 1]!.timestamp - pointA.timestamp) <
        Math.abs(seriesB[j]!.timestamp - pointA.timestamp)
    ) {
      j++;
    }

    if (j < seriesB.length && Math.abs(seriesB[j]!.timestamp - pointA.timestamp) <= toleranceMs) {
      result.push({ a: pointA.price, b: seriesB[j]!.price, timestamp: pointA.timestamp });
    }
  }

  return result;
}

/** Compute trend direction from a short price series */
function computeTrend(prices: number[]): 'up' | 'down' | 'flat' {
  if (prices.length < 2) return 'flat';
  const first = prices[0]!;
  const last = prices[prices.length - 1]!;
  const change = percentChange(first, last);
  if (change > 1) return 'up';
  if (change < -1) return 'down';
  return 'flat';
}

/** Compute percent change from a to b */
function percentChange(a: number, b: number): number {
  if (a === 0) return 0;
  return ((b - a) / Math.abs(a)) * 100;
}

// ─── Default Export ────────────────────────────────────────────────────────────

export default {
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
};
