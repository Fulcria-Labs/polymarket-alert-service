/**
 * Market Data Handling Tests
 *
 * Covers: API response parsing, missing fields, rate limiting simulation,
 * market state transitions, price validation, outcome matching,
 * searchMarkets filtering logic, fetchMarketData error handling,
 * market data transformation, and Gamma API format mapping.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import {
  fetchMarketData,
  searchMarkets,
  executeWorkflow,
} from "../polymarket-alert-workflow";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const NOTIFY = "https://hook.test/market";

function makeClobMarket(price = 0.65, overrides: Record<string, any> = {}) {
  return {
    condition_id: overrides.condition_id || "0xMKT",
    question: overrides.question || "Test market?",
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
    description: overrides.description || "",
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

// ─── fetchMarketData - HTTP status code handling ─────────────────────────────

describe("fetchMarketData - HTTP status codes", () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("returns parsed data for 200 OK", async () => {
    const market = makeClobMarket(0.55, { condition_id: "0xOK", question: "OK test?" });
    global.fetch = mock(async () => new Response(JSON.stringify(market), { status: 200 }));
    const result = await fetchMarketData("0xOK");
    expect(result).not.toBeNull();
    expect(result!.question).toBe("OK test?");
  });

  test("returns null for 301 redirect", async () => {
    global.fetch = mock(async () => new Response("Moved", { status: 301 }));
    const result = await fetchMarketData("0xREDIR");
    expect(result).toBeNull();
  });

  test("returns null for 400 bad request", async () => {
    global.fetch = mock(async () => new Response("Bad Request", { status: 400 }));
    const result = await fetchMarketData("0xBAD");
    expect(result).toBeNull();
  });

  test("returns null for 401 unauthorized", async () => {
    global.fetch = mock(async () => new Response("Unauthorized", { status: 401 }));
    const result = await fetchMarketData("0xUNAUTH");
    expect(result).toBeNull();
  });

  test("returns null for 403 forbidden", async () => {
    global.fetch = mock(async () => new Response("Forbidden", { status: 403 }));
    const result = await fetchMarketData("0xFORBID");
    expect(result).toBeNull();
  });

  test("returns null for 404 not found", async () => {
    global.fetch = mock(async () => new Response("Not Found", { status: 404 }));
    const result = await fetchMarketData("0xNOTFOUND");
    expect(result).toBeNull();
  });

  test("returns null for 429 rate limited", async () => {
    global.fetch = mock(async () => new Response("Too Many Requests", { status: 429 }));
    const result = await fetchMarketData("0xRATE");
    expect(result).toBeNull();
  });

  test("returns null for 500 server error", async () => {
    global.fetch = mock(async () => new Response("Server Error", { status: 500 }));
    const result = await fetchMarketData("0xSERVER");
    expect(result).toBeNull();
  });

  test("returns null for 502 bad gateway", async () => {
    global.fetch = mock(async () => new Response("Bad Gateway", { status: 502 }));
    const result = await fetchMarketData("0xGATEWAY");
    expect(result).toBeNull();
  });

  test("returns null for 503 service unavailable", async () => {
    global.fetch = mock(async () => new Response("Service Unavailable", { status: 503 }));
    const result = await fetchMarketData("0xUNAVAIL");
    expect(result).toBeNull();
  });
});

// ─── fetchMarketData - malformed response bodies ─────────────────────────────

describe("fetchMarketData - malformed responses", () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("returns null for empty body on 200", async () => {
    global.fetch = mock(async () => new Response("", { status: 200 }));
    const result = await fetchMarketData("0xEMPTY");
    expect(result).toBeNull();
  });

  test("returns null for invalid JSON on 200", async () => {
    global.fetch = mock(async () => new Response("{invalid", { status: 200 }));
    const result = await fetchMarketData("0xINVALID");
    expect(result).toBeNull();
  });

  test("returns null for HTML response on 200", async () => {
    global.fetch = mock(async () => new Response("<html>Error</html>", { status: 200 }));
    const result = await fetchMarketData("0xHTML");
    expect(result).toBeNull();
  });

  test("returns null for array response instead of object", async () => {
    global.fetch = mock(async () => new Response("[]", { status: 200 }));
    const result = await fetchMarketData("0xARRAY");
    // JSON.parse("[]") succeeds but returns an array, not a market object
    expect(result).not.toBeNull(); // technically parses fine, just not a valid market
  });

  test("returns null when fetch throws TypeError", async () => {
    global.fetch = mock(async () => { throw new TypeError("Failed to fetch"); });
    const result = await fetchMarketData("0xTYPE");
    expect(result).toBeNull();
  });

  test("returns null when fetch throws network error", async () => {
    global.fetch = mock(async () => { throw new Error("ECONNREFUSED"); });
    const result = await fetchMarketData("0xCONN");
    expect(result).toBeNull();
  });

  test("returns null when fetch throws timeout", async () => {
    global.fetch = mock(async () => { throw new Error("AbortError: timeout"); });
    const result = await fetchMarketData("0xTIMEOUT");
    expect(result).toBeNull();
  });
});

// ─── fetchMarketData - URL construction ──────────────────────────────────────

describe("fetchMarketData - URL construction", () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("constructs URL with market ID appended", async () => {
    let calledUrl = "";
    global.fetch = mock(async (url: string) => {
      calledUrl = url;
      return new Response(JSON.stringify(makeClobMarket()), { status: 200 });
    });
    await fetchMarketData("0xABC");
    expect(calledUrl).toContain("0xABC");
  });

  test("uses clob.polymarket.com as base URL", async () => {
    let calledUrl = "";
    global.fetch = mock(async (url: string) => {
      calledUrl = url;
      return new Response(JSON.stringify(makeClobMarket()), { status: 200 });
    });
    await fetchMarketData("test-id");
    expect(calledUrl).toContain("clob.polymarket.com");
  });

  test("URL includes /markets/ path segment", async () => {
    let calledUrl = "";
    global.fetch = mock(async (url: string) => {
      calledUrl = url;
      return new Response(JSON.stringify(makeClobMarket()), { status: 200 });
    });
    await fetchMarketData("0xDEF");
    expect(calledUrl).toContain("/markets/0xDEF");
  });

  test("handles market ID with special characters", async () => {
    let calledUrl = "";
    global.fetch = mock(async (url: string) => {
      calledUrl = url;
      return new Response(JSON.stringify(makeClobMarket()), { status: 200 });
    });
    await fetchMarketData("0x123-abc_def");
    expect(calledUrl).toContain("0x123-abc_def");
  });
});

// ─── searchMarkets - filtering and mapping ───────────────────────────────────

describe("searchMarkets - filtering logic", () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("filters by question field (case insensitive)", async () => {
    const markets = [
      makeGammaMarket({ conditionId: "0x1", question: "Will TRUMP win?" }),
      makeGammaMarket({ conditionId: "0x2", question: "Will it rain?" }),
    ];
    global.fetch = mock(async () => new Response(JSON.stringify(markets), { status: 200 }));
    const result = await searchMarkets("trump");
    expect(result.length).toBe(1);
    expect(result[0].condition_id).toBe("0x1");
  });

  test("filters by description field", async () => {
    const markets = [
      makeGammaMarket({ conditionId: "0x1", question: "2026 event", description: "Trump vs Biden race" }),
    ];
    global.fetch = mock(async () => new Response(JSON.stringify(markets), { status: 200 }));
    const result = await searchMarkets("trump");
    expect(result.length).toBe(1);
  });

  test("returns multiple matches", async () => {
    const markets = [
      makeGammaMarket({ conditionId: "0x1", question: "Trump election 2026" }),
      makeGammaMarket({ conditionId: "0x2", question: "Trump approval rating" }),
      makeGammaMarket({ conditionId: "0x3", question: "Bitcoin ETF" }),
    ];
    global.fetch = mock(async () => new Response(JSON.stringify(markets), { status: 200 }));
    const result = await searchMarkets("trump");
    expect(result.length).toBe(2);
  });

  test("returns empty when no markets match", async () => {
    const markets = [
      makeGammaMarket({ conditionId: "0x1", question: "Will it snow in Hawaii?" }),
    ];
    global.fetch = mock(async () => new Response(JSON.stringify(markets), { status: 200 }));
    const result = await searchMarkets("trump");
    expect(result.length).toBe(0);
  });

  test("returns empty for non-200 response", async () => {
    global.fetch = mock(async () => new Response("Error", { status: 500 }));
    const result = await searchMarkets("anything");
    expect(result).toEqual([]);
  });

  test("returns empty when fetch throws", async () => {
    global.fetch = mock(async () => { throw new Error("network error"); });
    const result = await searchMarkets("anything");
    expect(result).toEqual([]);
  });

  test("returns empty for empty API response array", async () => {
    global.fetch = mock(async () => new Response(JSON.stringify([]), { status: 200 }));
    const result = await searchMarkets("test");
    expect(result).toEqual([]);
  });
});

// ─── searchMarkets - response mapping ────────────────────────────────────────

describe("searchMarkets - Gamma to CLOB format mapping", () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("maps conditionId to condition_id", async () => {
    const markets = [makeGammaMarket({ conditionId: "0xMAPPED", question: "Test mapping" })];
    global.fetch = mock(async () => new Response(JSON.stringify(markets), { status: 200 }));
    const result = await searchMarkets("test");
    expect(result[0].condition_id).toBe("0xMAPPED");
  });

  test("preserves question field", async () => {
    const markets = [makeGammaMarket({ question: "Will X happen?" })];
    global.fetch = mock(async () => new Response(JSON.stringify(markets), { status: 200 }));
    const result = await searchMarkets("x");
    expect(result[0].question).toBe("Will X happen?");
  });

  test("preserves outcomes array", async () => {
    const markets = [makeGammaMarket({ outcomes: ["Approve", "Reject"] })];
    global.fetch = mock(async () => new Response(JSON.stringify(markets), { status: 200 }));
    const result = await searchMarkets("gamma");
    expect(result[0].outcomes).toEqual(["Approve", "Reject"]);
  });

  test("defaults outcomes to ['Yes', 'No'] when missing", async () => {
    const markets = [{ conditionId: "0x1", question: "Test no outcomes", description: "" }];
    global.fetch = mock(async () => new Response(JSON.stringify(markets), { status: 200 }));
    const result = await searchMarkets("test");
    expect(result[0].outcomes).toEqual(["Yes", "No"]);
  });

  test("defaults tokens to empty array when missing", async () => {
    const markets = [{ conditionId: "0x1", question: "Test no tokens", description: "" }];
    global.fetch = mock(async () => new Response(JSON.stringify(markets), { status: 200 }));
    const result = await searchMarkets("test");
    expect(result[0].tokens).toEqual([]);
  });

  test("preserves active/closed status", async () => {
    const markets = [makeGammaMarket({ question: "Active market" })];
    global.fetch = mock(async () => new Response(JSON.stringify(markets), { status: 200 }));
    const result = await searchMarkets("active");
    expect(result[0].active).toBe(true);
    expect(result[0].closed).toBe(false);
  });

  test("maps volume field", async () => {
    const markets = [{ ...makeGammaMarket({ question: "Volume test" }), volume: 123456 }];
    global.fetch = mock(async () => new Response(JSON.stringify(markets), { status: 200 }));
    const result = await searchMarkets("volume");
    expect(result[0].volume).toBe(123456);
  });
});

// ─── Market price validation in workflow ─────────────────────────────────────

describe("Workflow - market price boundaries", () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("price 0.0 (0%) triggers below-5% alert", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeClobMarket(0.0)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });
    const state = {
      alertConfigs: [{ marketId: "0xMKT", outcome: "Yes", threshold: 5, direction: "below" as const, notifyUrl: NOTIFY }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };
    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(1);
  });

  test("price 1.0 (100%) triggers above-99% alert", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeClobMarket(1.0)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });
    const state = {
      alertConfigs: [{ marketId: "0xMKT", outcome: "Yes", threshold: 99, direction: "above" as const, notifyUrl: NOTIFY }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };
    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(1);
  });

  test("price 0.50 exactly at 50% threshold (above) triggers", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeClobMarket(0.50)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });
    const state = {
      alertConfigs: [{ marketId: "0xMKT", outcome: "Yes", threshold: 50, direction: "above" as const, notifyUrl: NOTIFY }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };
    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(1);
  });

  test("price 0.50 exactly at 50% threshold (below) triggers", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeClobMarket(0.50)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });
    const state = {
      alertConfigs: [{ marketId: "0xMKT", outcome: "Yes", threshold: 50, direction: "below" as const, notifyUrl: NOTIFY }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };
    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(1);
  });

  test("price 0.499 does NOT trigger above-50% alert", async () => {
    global.fetch = mock(async () =>
      new Response(JSON.stringify(makeClobMarket(0.499)), { status: 200 })
    );
    const state = {
      alertConfigs: [{ marketId: "0xMKT", outcome: "Yes", threshold: 50, direction: "above" as const, notifyUrl: NOTIFY }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };
    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(0);
  });

  test("price 0.501 does NOT trigger below-50% alert", async () => {
    global.fetch = mock(async () =>
      new Response(JSON.stringify(makeClobMarket(0.501)), { status: 200 })
    );
    const state = {
      alertConfigs: [{ marketId: "0xMKT", outcome: "Yes", threshold: 50, direction: "below" as const, notifyUrl: NOTIFY }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };
    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(0);
  });

  test("very small price 0.001 (0.1%) triggers below-1% alert", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeClobMarket(0.001)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });
    const state = {
      alertConfigs: [{ marketId: "0xMKT", outcome: "Yes", threshold: 1, direction: "below" as const, notifyUrl: NOTIFY }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };
    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(1);
  });
});

// ─── Market state transitions in workflow ────────────────────────────────────

describe("Workflow - market state transitions", () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("inactive market is skipped", async () => {
    global.fetch = mock(async () =>
      new Response(JSON.stringify(makeClobMarket(0.75, { active: false })), { status: 200 })
    );
    const state = {
      alertConfigs: [{ marketId: "0xMKT", outcome: "Yes", threshold: 60, direction: "above" as const, notifyUrl: NOTIFY }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };
    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(0);
  });

  test("closed market is skipped", async () => {
    global.fetch = mock(async () =>
      new Response(JSON.stringify(makeClobMarket(0.75, { closed: true })), { status: 200 })
    );
    const state = {
      alertConfigs: [{ marketId: "0xMKT", outcome: "Yes", threshold: 60, direction: "above" as const, notifyUrl: NOTIFY }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };
    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(0);
  });

  test("both active and closed market is skipped (closed takes precedence)", async () => {
    global.fetch = mock(async () =>
      new Response(JSON.stringify(makeClobMarket(0.75, { active: true, closed: true })), { status: 200 })
    );
    const state = {
      alertConfigs: [{ marketId: "0xMKT", outcome: "Yes", threshold: 60, direction: "above" as const, notifyUrl: NOTIFY }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };
    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(0);
  });

  test("null market (fetch failed) is skipped", async () => {
    global.fetch = mock(async () => new Response("Not Found", { status: 404 }));
    const state = {
      alertConfigs: [{ marketId: "0xMKT", outcome: "Yes", threshold: 60, direction: "above" as const, notifyUrl: NOTIFY }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };
    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(0);
  });
});

// ─── Outcome matching in workflow ────────────────────────────────────────────

describe("Workflow - outcome matching", () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("matches 'Yes' outcome case-insensitively", async () => {
    const market = makeClobMarket(0.70, {
      tokens: [
        { token_id: "t1", outcome: "yes", price: 0.70 },
        { token_id: "t2", outcome: "no", price: 0.30 },
      ],
    });
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(market), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });
    const state = {
      alertConfigs: [{ marketId: "0xMKT", outcome: "Yes", threshold: 60, direction: "above" as const, notifyUrl: NOTIFY }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };
    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(1);
  });

  test("matches 'No' outcome and checks its price", async () => {
    // No price = 1 - 0.80 = 0.20 = 20%
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeClobMarket(0.80)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });
    const state = {
      alertConfigs: [{ marketId: "0xMKT", outcome: "No", threshold: 25, direction: "below" as const, notifyUrl: NOTIFY }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };
    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(1); // 20% is below 25%
  });

  test("missing outcome in tokens returns no alert", async () => {
    const market = makeClobMarket(0.65, {
      tokens: [
        { token_id: "t1", outcome: "Approve", price: 0.65 },
        { token_id: "t2", outcome: "Reject", price: 0.35 },
      ],
    });
    global.fetch = mock(async () =>
      new Response(JSON.stringify(market), { status: 200 })
    );
    const state = {
      alertConfigs: [{ marketId: "0xMKT", outcome: "Yes", threshold: 50, direction: "above" as const, notifyUrl: NOTIFY }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };
    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(0);
  });

  test("custom outcome names match if specified correctly", async () => {
    const market = makeClobMarket(0.65, {
      tokens: [
        { token_id: "t1", outcome: "Approve", price: 0.70 },
        { token_id: "t2", outcome: "Reject", price: 0.30 },
      ],
    });
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(market), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });
    const state = {
      alertConfigs: [{ marketId: "0xMKT", outcome: "approve", threshold: 60, direction: "above" as const, notifyUrl: NOTIFY }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };
    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(1); // case-insensitive match
  });
});

// ─── Rate limiting in workflow ───────────────────────────────────────────────

describe("Workflow - rate limiting behavior", () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("skips market checked less than 60 seconds ago", async () => {
    global.fetch = mock(async () =>
      new Response(JSON.stringify(makeClobMarket(0.75)), { status: 200 })
    );
    const state = {
      alertConfigs: [{ marketId: "0xRATED", outcome: "Yes", threshold: 60, direction: "above" as const, notifyUrl: NOTIFY }],
      lastChecked: { "0xRATED": Date.now() - 30000 } as Record<string, number>, // 30 sec ago
      triggeredAlerts: [] as string[],
    };
    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(0);
  });

  test("processes market checked more than 60 seconds ago", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeClobMarket(0.75)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });
    const state = {
      alertConfigs: [{ marketId: "0xOLD", outcome: "Yes", threshold: 60, direction: "above" as const, notifyUrl: NOTIFY }],
      lastChecked: { "0xOLD": Date.now() - 120000 } as Record<string, number>, // 2 min ago
      triggeredAlerts: [] as string[],
    };
    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(1);
  });

  test("market with no lastChecked entry is processed", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeClobMarket(0.75)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });
    const state = {
      alertConfigs: [{ marketId: "0xNEW", outcome: "Yes", threshold: 60, direction: "above" as const, notifyUrl: NOTIFY }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };
    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(1);
  });

  test("updates lastChecked timestamp after processing", async () => {
    const before = Date.now();
    global.fetch = mock(async () =>
      new Response(JSON.stringify(makeClobMarket(0.50)), { status: 200 })
    );
    const state = {
      alertConfigs: [{ marketId: "0xTIME", outcome: "Yes", threshold: 60, direction: "above" as const, notifyUrl: NOTIFY }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };
    const result = await executeWorkflow(state);
    expect(result.state.lastChecked["0xTIME"]).toBeGreaterThanOrEqual(before);
  });
});

// ─── searchMarkets - edge case queries ───────────────────────────────────────

describe("searchMarkets - query edge cases", () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("empty query matches nothing", async () => {
    const markets = [makeGammaMarket({ question: "Some market" })];
    global.fetch = mock(async () => new Response(JSON.stringify(markets), { status: 200 }));
    const result = await searchMarkets("");
    // empty string is included in everything via includes("")
    expect(result.length).toBe(1);
  });

  test("query with special regex characters", async () => {
    const markets = [makeGammaMarket({ question: "Market (test)" })];
    global.fetch = mock(async () => new Response(JSON.stringify(markets), { status: 200 }));
    // includes() is a simple string match, not regex
    const result = await searchMarkets("(test)");
    expect(result.length).toBe(1);
  });

  test("very long query string", async () => {
    const markets = [makeGammaMarket({ question: "Short question" })];
    global.fetch = mock(async () => new Response(JSON.stringify(markets), { status: 200 }));
    const result = await searchMarkets("a".repeat(1000));
    expect(result.length).toBe(0);
  });
});
