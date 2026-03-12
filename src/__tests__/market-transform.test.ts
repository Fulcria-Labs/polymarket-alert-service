/**
 * Market Data Transformation Edge Cases
 *
 * Covers: price format conversions, market response mapping, outcome name
 * matching, volume handling, token ID management, active/closed state
 * transitions, market question formatting, multi-outcome markets,
 * missing fields in API responses, Gamma-to-CLOB format mapping.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import {
  fetchMarketData,
  searchMarkets,
  executeWorkflow,
} from "../polymarket-alert-workflow";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeClobMarket(price = 0.65, overrides: Record<string, any> = {}) {
  return {
    condition_id: overrides.condition_id || "0xTRNS",
    question: overrides.question || "Transform test?",
    outcomes: overrides.outcomes || ["Yes", "No"],
    tokens: overrides.tokens || [
      { token_id: "t1", outcome: "Yes", price, winner: false },
      { token_id: "t2", outcome: "No", price: 1 - price, winner: false },
    ],
    active: overrides.active !== undefined ? overrides.active : true,
    closed: overrides.closed !== undefined ? overrides.closed : false,
    volume: overrides.volume !== undefined ? overrides.volume : 50000,
  };
}

function makeGammaMarket(overrides: Record<string, any> = {}) {
  return {
    conditionId: overrides.conditionId || "0xGAMMA",
    question: overrides.question || "Gamma test?",
    description: overrides.description || "Gamma description",
    outcomes: overrides.outcomes || ["Yes", "No"],
    tokens: overrides.tokens || [
      { token_id: "t1", outcome: "Yes", price: 0.60 },
      { token_id: "t2", outcome: "No", price: 0.40 },
    ],
    active: true,
    closed: false,
    volume: 75000,
  };
}

// ─── Price format conversions ───────────────────────────────────────────────

describe("Market transform - price conversions", () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("price 0.0 converts to 0% correctly", async () => {
    const market = makeClobMarket(0.0);
    global.fetch = mock(async () => new Response(JSON.stringify(market)));
    const result = await fetchMarketData("0xZERO");
    expect(result).not.toBeNull();
    expect(result!.tokens[0].price).toBe(0);
  });

  test("price 1.0 converts to 100% correctly", async () => {
    const market = makeClobMarket(1.0);
    market.tokens[1].price = 0;
    global.fetch = mock(async () => new Response(JSON.stringify(market)));
    const result = await fetchMarketData("0xFULL");
    expect(result).not.toBeNull();
    expect(result!.tokens[0].price).toBe(1.0);
  });

  test("price 0.5 is the midpoint", async () => {
    const market = makeClobMarket(0.5);
    global.fetch = mock(async () => new Response(JSON.stringify(market)));
    const result = await fetchMarketData("0xMID");
    expect(result).not.toBeNull();
    expect(result!.tokens[0].price).toBe(0.5);
  });

  test("very precise price is preserved", async () => {
    const market = makeClobMarket(0.123456789);
    global.fetch = mock(async () => new Response(JSON.stringify(market)));
    const result = await fetchMarketData("0xPRECISE");
    expect(result).not.toBeNull();
    expect(result!.tokens[0].price).toBeCloseTo(0.123456789, 6);
  });

  test("price near 0 (0.001) is preserved", async () => {
    const market = makeClobMarket(0.001);
    global.fetch = mock(async () => new Response(JSON.stringify(market)));
    const result = await fetchMarketData("0xNEARZERO");
    expect(result).not.toBeNull();
    expect(result!.tokens[0].price).toBeCloseTo(0.001, 4);
  });

  test("price near 1 (0.999) is preserved", async () => {
    const market = makeClobMarket(0.999);
    global.fetch = mock(async () => new Response(JSON.stringify(market)));
    const result = await fetchMarketData("0xNEARONE");
    expect(result).not.toBeNull();
    expect(result!.tokens[0].price).toBeCloseTo(0.999, 4);
  });
});

// ─── Market response field mapping ──────────────────────────────────────────

describe("Market transform - field mapping", () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("condition_id is mapped correctly", async () => {
    const market = makeClobMarket(0.5, { condition_id: "0xABC123" });
    global.fetch = mock(async () => new Response(JSON.stringify(market)));
    const result = await fetchMarketData("0xABC123");
    expect(result!.condition_id).toBe("0xABC123");
  });

  test("question is mapped correctly", async () => {
    const market = makeClobMarket(0.5, { question: "Will it rain tomorrow?" });
    global.fetch = mock(async () => new Response(JSON.stringify(market)));
    const result = await fetchMarketData("0xQ");
    expect(result!.question).toBe("Will it rain tomorrow?");
  });

  test("outcomes array is mapped correctly", async () => {
    const market = makeClobMarket(0.5, { outcomes: ["Yes", "No"] });
    global.fetch = mock(async () => new Response(JSON.stringify(market)));
    const result = await fetchMarketData("0xO");
    expect(result!.outcomes).toEqual(["Yes", "No"]);
  });

  test("active status is mapped correctly", async () => {
    const market = makeClobMarket(0.5, { active: true });
    global.fetch = mock(async () => new Response(JSON.stringify(market)));
    const result = await fetchMarketData("0xACT");
    expect(result!.active).toBe(true);
  });

  test("closed status is mapped correctly", async () => {
    const market = makeClobMarket(0.5, { closed: true });
    global.fetch = mock(async () => new Response(JSON.stringify(market)));
    const result = await fetchMarketData("0xCLOSED");
    expect(result!.closed).toBe(true);
  });

  test("volume is mapped correctly", async () => {
    const market = makeClobMarket(0.5, { volume: 123456 });
    global.fetch = mock(async () => new Response(JSON.stringify(market)));
    const result = await fetchMarketData("0xVOL");
    expect(result!.volume).toBe(123456);
  });
});

// ─── Outcome name matching ──────────────────────────────────────────────────

describe("Market transform - outcome matching", () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("case-insensitive outcome matching (yes vs Yes)", async () => {
    const market = makeClobMarket(0.70);
    global.fetch = mock(async (url: string | Request) => {
      const urlStr = typeof url === "string" ? url : url.url;
      if (urlStr.includes("clob")) {
        return new Response(JSON.stringify(market));
      }
      return new Response("OK");
    });

    const state = {
      alertConfigs: [{
        marketId: "0xCASE",
        outcome: "yes", // lowercase
        threshold: 60,
        direction: "above" as const,
        notifyUrl: "https://hook",
      }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };

    const result = await executeWorkflow(state);
    expect(result.alerts.length).toBe(1); // Should match case-insensitively
  });

  test("outcome 'YES' (all caps) matches", async () => {
    const market = makeClobMarket(0.70);
    global.fetch = mock(async (url: string | Request) => {
      const urlStr = typeof url === "string" ? url : url.url;
      if (urlStr.includes("clob")) {
        return new Response(JSON.stringify(market));
      }
      return new Response("OK");
    });

    const state = {
      alertConfigs: [{
        marketId: "0xCAPS",
        outcome: "YES",
        threshold: 60,
        direction: "above" as const,
        notifyUrl: "https://hook",
      }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };

    const result = await executeWorkflow(state);
    expect(result.alerts.length).toBe(1);
  });

  test("non-existent outcome returns no alert", async () => {
    const market = makeClobMarket(0.70);
    global.fetch = mock(async () => new Response(JSON.stringify(market)));

    const state = {
      alertConfigs: [{
        marketId: "0xMISS",
        outcome: "Maybe",
        threshold: 60,
        direction: "above" as const,
        notifyUrl: "https://hook",
      }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };

    const result = await executeWorkflow(state);
    expect(result.alerts.length).toBe(0);
  });
});

// ─── Search markets filtering ──────────────────────────────────────────────

describe("Market transform - search filtering", () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("search filters by question text", async () => {
    global.fetch = mock(async () => {
      return new Response(JSON.stringify([
        makeGammaMarket({ question: "Will Trump win?", conditionId: "0x1" }),
        makeGammaMarket({ question: "Will it rain?", conditionId: "0x2" }),
        makeGammaMarket({ question: "Will Biden run?", conditionId: "0x3" }),
      ]));
    });

    const results = await searchMarkets("Trump");
    expect(results.length).toBe(1);
    expect(results[0].question).toContain("Trump");
  });

  test("search is case-insensitive", async () => {
    global.fetch = mock(async () => {
      return new Response(JSON.stringify([
        makeGammaMarket({ question: "Will BITCOIN rise?", conditionId: "0x1" }),
      ]));
    });

    const results = await searchMarkets("bitcoin");
    expect(results.length).toBe(1);
  });

  test("search filters by description too", async () => {
    global.fetch = mock(async () => {
      return new Response(JSON.stringify([
        makeGammaMarket({
          question: "Generic market?",
          description: "This is about ethereum ETF",
          conditionId: "0x1",
        }),
      ]));
    });

    const results = await searchMarkets("ethereum");
    expect(results.length).toBe(1);
  });

  test("search returns empty for no matches", async () => {
    global.fetch = mock(async () => {
      return new Response(JSON.stringify([
        makeGammaMarket({ question: "Will it rain?", conditionId: "0x1" }),
      ]));
    });

    const results = await searchMarkets("zzzznonexistent");
    expect(results.length).toBe(0);
  });

  test("search maps conditionId to condition_id", async () => {
    global.fetch = mock(async () => {
      return new Response(JSON.stringify([
        makeGammaMarket({ question: "Test market?", conditionId: "0xMAPPED" }),
      ]));
    });

    const results = await searchMarkets("test");
    expect(results.length).toBe(1);
    expect(results[0].condition_id).toBe("0xMAPPED");
  });

  test("search returns empty on API error", async () => {
    global.fetch = mock(async () => {
      return new Response("Server Error", { status: 500 });
    });

    const results = await searchMarkets("test");
    expect(results.length).toBe(0);
  });

  test("search returns empty on network error", async () => {
    global.fetch = mock(async () => {
      throw new Error("Network error");
    });

    const results = await searchMarkets("test");
    expect(results.length).toBe(0);
  });

  test("search handles null question gracefully", async () => {
    global.fetch = mock(async () => {
      return new Response(JSON.stringify([
        { conditionId: "0x1", question: null, description: null, outcomes: ["Yes", "No"], tokens: [], active: true, closed: false, volume: 0 },
      ]));
    });

    const results = await searchMarkets("test");
    expect(results.length).toBe(0); // null?.toLowerCase() won't match
  });
});

// ─── fetchMarketData error handling ────────────────────────────────────────

describe("Market transform - fetchMarketData error handling", () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("returns null for HTTP 500", async () => {
    global.fetch = mock(async () => new Response("Error", { status: 500 }));
    const result = await fetchMarketData("0xFAIL");
    expect(result).toBeNull();
  });

  test("returns null for HTTP 503", async () => {
    global.fetch = mock(async () => new Response("Unavailable", { status: 503 }));
    const result = await fetchMarketData("0xUNAVAIL");
    expect(result).toBeNull();
  });

  test("returns null for HTTP 429 rate limit", async () => {
    global.fetch = mock(async () => new Response("Rate Limited", { status: 429 }));
    const result = await fetchMarketData("0xRATED");
    expect(result).toBeNull();
  });

  test("returns null when fetch throws TypeError", async () => {
    global.fetch = mock(async () => { throw new TypeError("Failed to fetch"); });
    const result = await fetchMarketData("0xTYPE");
    expect(result).toBeNull();
  });

  test("returns parsed data for valid response", async () => {
    const market = makeClobMarket(0.55, { condition_id: "0xVALID" });
    global.fetch = mock(async () => new Response(JSON.stringify(market)));
    const result = await fetchMarketData("0xVALID");
    expect(result).not.toBeNull();
    expect(result!.condition_id).toBe("0xVALID");
  });

  test("returns null for empty body with 200 status", async () => {
    global.fetch = mock(async () => new Response("", { status: 200 }));
    const result = await fetchMarketData("0xEMPTY");
    // JSON.parse("") throws, caught as null
    expect(result).toBeNull();
  });

  test("returns null for invalid JSON body", async () => {
    global.fetch = mock(async () => new Response("not json", { status: 200 }));
    const result = await fetchMarketData("0xBADJSON");
    expect(result).toBeNull();
  });
});

// ─── Multi-outcome markets ─────────────────────────────────────────────────

describe("Market transform - multi-outcome markets", () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("handles 3-outcome market", async () => {
    const market = {
      condition_id: "0x3WAY",
      question: "Who will win?",
      outcomes: ["Alice", "Bob", "Charlie"],
      tokens: [
        { token_id: "t1", outcome: "Alice", price: 0.40, winner: false },
        { token_id: "t2", outcome: "Bob", price: 0.35, winner: false },
        { token_id: "t3", outcome: "Charlie", price: 0.25, winner: false },
      ],
      active: true,
      closed: false,
      volume: 100000,
    };
    global.fetch = mock(async () => new Response(JSON.stringify(market)));
    const result = await fetchMarketData("0x3WAY");
    expect(result!.tokens.length).toBe(3);
    expect(result!.outcomes.length).toBe(3);
  });

  test("handles market with single outcome", async () => {
    const market = {
      condition_id: "0x1WAY",
      question: "Will it happen?",
      outcomes: ["Yes"],
      tokens: [
        { token_id: "t1", outcome: "Yes", price: 0.80, winner: false },
      ],
      active: true,
      closed: false,
      volume: 5000,
    };
    global.fetch = mock(async () => new Response(JSON.stringify(market)));
    const result = await fetchMarketData("0x1WAY");
    expect(result!.tokens.length).toBe(1);
  });

  test("handles market with empty tokens array", async () => {
    const market = {
      condition_id: "0xNOTOK",
      question: "No tokens?",
      outcomes: ["Yes", "No"],
      tokens: [],
      active: true,
      closed: false,
      volume: 0,
    };
    global.fetch = mock(async () => new Response(JSON.stringify(market)));
    const result = await fetchMarketData("0xNOTOK");
    expect(result!.tokens.length).toBe(0);
  });
});

// ─── Volume handling ───────────────────────────────────────────────────────

describe("Market transform - volume handling", () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("zero volume market", async () => {
    const market = makeClobMarket(0.5, { volume: 0 });
    global.fetch = mock(async () => new Response(JSON.stringify(market)));
    const result = await fetchMarketData("0xZV");
    expect(result!.volume).toBe(0);
  });

  test("very high volume market", async () => {
    const market = makeClobMarket(0.5, { volume: 999999999 });
    global.fetch = mock(async () => new Response(JSON.stringify(market)));
    const result = await fetchMarketData("0xHV");
    expect(result!.volume).toBe(999999999);
  });

  test("undefined volume defaults correctly", async () => {
    const market = makeClobMarket(0.5);
    delete (market as any).volume;
    global.fetch = mock(async () => new Response(JSON.stringify(market)));
    const result = await fetchMarketData("0xUNDEF");
    expect(result).not.toBeNull();
  });
});
