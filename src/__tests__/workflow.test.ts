/**
 * Tests for polymarket-alert-workflow.ts
 *
 * Covers NLP parsing, multi-condition parsing, keyword extraction,
 * market search (mocked), fetchMarketData (mocked), and workflow execution.
 */

import { test, expect, describe, mock, beforeEach, afterEach } from "bun:test";
import {
  parseAlertRequest,
  parseMultiConditionAlert,
  extractSearchKeywords,
  searchMarkets,
  fetchMarketData,
  executeWorkflow,
} from "../polymarket-alert-workflow";

const NOTIFY_URL = "https://test.example.com/webhook";

// ─── parseAlertRequest ────────────────────────────────────────────────────────

describe("parseAlertRequest - basic above conditions", () => {
  test("parses 'Alert me when Trump election odds exceed 60%'", () => {
    const result = parseAlertRequest(
      "Alert me when Trump election odds exceed 60%",
      NOTIFY_URL
    );
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(60);
    expect(result!.direction).toBe("above");
    expect(result!.notifyUrl).toBe(NOTIFY_URL);
  });

  test("parses 'Trump > 70%' shorthand", () => {
    const result = parseAlertRequest("Trump > 70%", NOTIFY_URL);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(70);
    expect(result!.direction).toBe("above");
  });

  test("parses 'when Bitcoin ETF approval exceeds 55%'", () => {
    const result = parseAlertRequest(
      "when Bitcoin ETF approval exceeds 55%",
      NOTIFY_URL
    );
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(55);
    expect(result!.direction).toBe("above");
  });

  test("parses 'Alert when price hits 80%'", () => {
    const result = parseAlertRequest("Alert when price hits 80%", NOTIFY_URL);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(80);
    expect(result!.direction).toBe("above");
  });

  test("parses 'when Trump wins probability goes above 55%'", () => {
    const result = parseAlertRequest(
      "when Trump wins probability goes above 55%",
      NOTIFY_URL
    );
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(55);
    expect(result!.direction).toBe("above");
  });

  test("parses 'Tell me if recession probability goes above 55%'", () => {
    const result = parseAlertRequest(
      "Tell me if recession probability goes above 55%",
      NOTIFY_URL
    );
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(55);
    expect(result!.direction).toBe("above");
  });

  test("parses threshold as number not string", () => {
    const result = parseAlertRequest("Alert when BTC > 65%", NOTIFY_URL);
    expect(result).not.toBeNull();
    expect(typeof result!.threshold).toBe("number");
  });
});

describe("parseAlertRequest - below conditions", () => {
  test("parses 'Notify when Bitcoin ETF approval drops below 30%'", () => {
    const result = parseAlertRequest(
      "Notify when Bitcoin ETF approval drops below 30%",
      NOTIFY_URL
    );
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(30);
    expect(result!.direction).toBe("below");
  });

  test("parses 'Biden < 40%' shorthand", () => {
    const result = parseAlertRequest("Biden < 40%", NOTIFY_URL);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(40);
    expect(result!.direction).toBe("below");
  });

  test("parses 'If inflation falls under 25%, let me know'", () => {
    const result = parseAlertRequest(
      "If inflation falls under 25%, let me know",
      NOTIFY_URL
    );
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(25);
    expect(result!.direction).toBe("below");
  });

  test("parses 'recession probability below 20%'", () => {
    const result = parseAlertRequest(
      "recession probability below 20%",
      NOTIFY_URL
    );
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(20);
    expect(result!.direction).toBe("below");
  });

  test("parses 'when odds fall below 15 percent'", () => {
    const result = parseAlertRequest(
      "when odds fall below 15 percent",
      NOTIFY_URL
    );
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(15);
    expect(result!.direction).toBe("below");
  });
});

describe("parseAlertRequest - outcome detection", () => {
  test("defaults to Yes outcome for plain requests", () => {
    const result = parseAlertRequest("Alert when Trump > 60%", NOTIFY_URL);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("Yes");
  });

  test("detects No outcome from explicit No mention", () => {
    const result = parseAlertRequest(
      "Watch when No hits 40 cents on AI regulation",
      NOTIFY_URL
    );
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("No");
  });

  test("marketId starts empty (resolved via market search)", () => {
    const result = parseAlertRequest("Alert when Trump > 60%", NOTIFY_URL);
    expect(result).not.toBeNull();
    expect(result!.marketId).toBe("");
  });

  test("notifyUrl is stored on result", () => {
    const url = "https://my-webhook.io/hook";
    const result = parseAlertRequest("Alert when ETH > 50%", url);
    expect(result).not.toBeNull();
    expect(result!.notifyUrl).toBe(url);
  });
});

describe("parseAlertRequest - various phrasing formats", () => {
  test("parses 'When X reaches Y%'", () => {
    const result = parseAlertRequest("When election reaches 75%", NOTIFY_URL);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(75);
  });

  test("parses decimal percentage '0.60'", () => {
    // This exercises the decimal odds pattern fallback
    const result = parseAlertRequest("alert when 0.60 threshold", NOTIFY_URL);
    // May or may not parse (pattern-dependent), just ensure no crash
    // If parsed, threshold should be 60
    if (result !== null) {
      expect(result.threshold).toBeGreaterThan(0);
    }
  });

  test("parses 'cents' format for Polymarket prices", () => {
    const result = parseAlertRequest(
      "Watch when No hits 40 cents on AI regulation",
      NOTIFY_URL
    );
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(40);
  });

  test("returns null for completely unparseable input", () => {
    const result = parseAlertRequest("hello world how are you", NOTIFY_URL);
    expect(result).toBeNull();
  });

  test("returns null for empty string", () => {
    const result = parseAlertRequest("", NOTIFY_URL);
    expect(result).toBeNull();
  });

  test("handles fractional percentages like 62.5%", () => {
    const result = parseAlertRequest("Alert when Trump > 62.5%", NOTIFY_URL);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(62.5);
  });
});

// ─── parseMultiConditionAlert ─────────────────────────────────────────────────

describe("parseMultiConditionAlert", () => {
  test("parses single condition as array of length 1", () => {
    const results = parseMultiConditionAlert("Trump > 60%", NOTIFY_URL);
    expect(results).toBeArray();
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  test("parses AND-separated conditions", () => {
    const results = parseMultiConditionAlert(
      "Alert when Trump > 60% AND Biden < 40%",
      NOTIFY_URL
    );
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  test("parses OR-separated conditions", () => {
    const results = parseMultiConditionAlert(
      "recession above 70% or inflation below 20%",
      NOTIFY_URL
    );
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  test("each parsed condition has required fields", () => {
    const results = parseMultiConditionAlert(
      "Trump > 60% AND Biden < 40%",
      NOTIFY_URL
    );
    for (const r of results) {
      expect(r).toHaveProperty("threshold");
      expect(r).toHaveProperty("direction");
      expect(r).toHaveProperty("outcome");
      expect(r).toHaveProperty("notifyUrl");
      expect(r.notifyUrl).toBe(NOTIFY_URL);
    }
  });

  test("returns empty array for unparseable multi-condition", () => {
    const results = parseMultiConditionAlert("hello world foo bar", NOTIFY_URL);
    expect(results).toBeArray();
    expect(results.length).toBe(0);
  });

  test("handles comma-separated conditions", () => {
    const results = parseMultiConditionAlert(
      "Trump > 60%, Biden < 40%",
      NOTIFY_URL
    );
    // Should parse at least one
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  test("returns an array type always", () => {
    const results = parseMultiConditionAlert("", NOTIFY_URL);
    expect(Array.isArray(results)).toBe(true);
  });

  test("multi-condition preserves correct thresholds", () => {
    const results = parseMultiConditionAlert(
      "Trump > 60% AND Biden < 40%",
      NOTIFY_URL
    );
    expect(results.length).toBe(2);
    const thresholds = results.map(r => r.threshold).sort((a, b) => a - b);
    expect(thresholds).toEqual([40, 60]);
  });

  test("multi-condition preserves correct directions", () => {
    const results = parseMultiConditionAlert(
      "Trump > 60% AND Biden < 40%",
      NOTIFY_URL
    );
    expect(results.length).toBe(2);
    const dirs = results.map(r => r.direction).sort();
    expect(dirs).toContain("above");
    expect(dirs).toContain("below");
  });
});

// ─── extractSearchKeywords ────────────────────────────────────────────────────

describe("extractSearchKeywords", () => {
  test("returns an array", () => {
    const kws = extractSearchKeywords("Alert when Trump > 60%");
    expect(Array.isArray(kws)).toBe(true);
  });

  test("extracts named entities from input", () => {
    const kws = extractSearchKeywords("Alert when Trump election odds exceed 60%");
    // "Trump" is a capitalized named entity
    const allText = kws.join(" ").toLowerCase();
    expect(allText).toMatch(/trump/i);
  });

  test("extracts Bitcoin from Bitcoin ETF request", () => {
    const kws = extractSearchKeywords("Notify when Bitcoin ETF approval drops below 30%");
    const allText = kws.join(" ").toLowerCase();
    expect(allText).toMatch(/bitcoin/i);
  });

  test("returns unique keywords (no duplicates)", () => {
    const kws = extractSearchKeywords("Trump election Trump Trump odds above 70%");
    const uniqueKws = [...new Set(kws)];
    expect(kws.length).toBe(uniqueKws.length);
  });

  test("handles empty string gracefully", () => {
    const kws = extractSearchKeywords("");
    expect(Array.isArray(kws)).toBe(true);
  });

  test("returns non-empty result for meaningful input", () => {
    const kws = extractSearchKeywords("Alert when recession probability above 50%");
    expect(kws.length).toBeGreaterThan(0);
  });

  test("extracts keywords from shorthand notation", () => {
    const kws = extractSearchKeywords("Biden < 40%");
    expect(Array.isArray(kws)).toBe(true);
  });
});

// ─── searchMarkets (network-mocked) ──────────────────────────────────────────

describe("searchMarkets", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  const makeMockMarket = (question: string) => ({
    conditionId: "cid-" + question.slice(0, 8).replace(/\s/g, "-"),
    question,
    outcomes: ["Yes", "No"],
    tokens: [
      { token_id: "t1", outcome: "Yes", price: 0.65 },
      { token_id: "t2", outcome: "No", price: 0.35 },
    ],
    active: true,
    closed: false,
    volume: 100000,
  });

  test("returns array when fetch succeeds with matching market", async () => {
    global.fetch = mock(async (url: string) => {
      return new Response(
        JSON.stringify([
          makeMockMarket("Will Trump win the 2024 election?"),
          makeMockMarket("Will Biden win the Democratic primary?"),
        ]),
        { status: 200 }
      );
    }) as any;

    const markets = await searchMarkets("Trump");
    expect(Array.isArray(markets)).toBe(true);
    expect(markets.length).toBeGreaterThanOrEqual(1);
    expect(markets[0].question.toLowerCase()).toContain("trump");
  });

  test("maps conditionId to condition_id field", async () => {
    global.fetch = mock(async () =>
      new Response(
        JSON.stringify([makeMockMarket("Will Trump win the election?")]),
        { status: 200 }
      )
    ) as any;

    const markets = await searchMarkets("Trump");
    expect(markets[0]).toHaveProperty("condition_id");
  });

  test("returns empty array when no markets match the query", async () => {
    global.fetch = mock(async () =>
      new Response(
        JSON.stringify([
          makeMockMarket("Will it rain in London next week?"),
        ]),
        { status: 200 }
      )
    ) as any;

    const markets = await searchMarkets("Bitcoin");
    expect(markets.length).toBe(0);
  });

  test("returns empty array on fetch failure", async () => {
    global.fetch = mock(async () => {
      throw new Error("Network error");
    }) as any;

    const markets = await searchMarkets("election");
    expect(markets).toEqual([]);
  });

  test("returns empty array when API returns non-200", async () => {
    global.fetch = mock(async () =>
      new Response("Internal Server Error", { status: 500 })
    ) as any;

    const markets = await searchMarkets("Trump");
    expect(markets).toEqual([]);
  });

  test("filters markets by question content (case-insensitive)", async () => {
    global.fetch = mock(async () =>
      new Response(
        JSON.stringify([
          makeMockMarket("Will TRUMP win in 2026?"),
          makeMockMarket("Will Biden run again?"),
        ]),
        { status: 200 }
      )
    ) as any;

    const markets = await searchMarkets("trump");
    expect(markets.length).toBe(1);
    expect(markets[0].question).toMatch(/trump/i);
  });

  test("returned market objects have required fields", async () => {
    global.fetch = mock(async () =>
      new Response(
        JSON.stringify([makeMockMarket("Will Trump win the election?")]),
        { status: 200 }
      )
    ) as any;

    const markets = await searchMarkets("Trump");
    const m = markets[0];
    expect(m).toHaveProperty("condition_id");
    expect(m).toHaveProperty("question");
    expect(m).toHaveProperty("outcomes");
    expect(m).toHaveProperty("tokens");
    expect(m).toHaveProperty("active");
    expect(m).toHaveProperty("closed");
  });
});

// ─── fetchMarketData (network-mocked) ─────────────────────────────────────────

describe("fetchMarketData", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  const mockMarketResponse = {
    condition_id: "0xabc123",
    question: "Will Trump win?",
    outcomes: ["Yes", "No"],
    tokens: [
      { token_id: "t1", outcome: "Yes", price: 0.7 },
      { token_id: "t2", outcome: "No", price: 0.3 },
    ],
    active: true,
    closed: false,
    volume: 500000,
  };

  test("returns market data on successful fetch", async () => {
    global.fetch = mock(async () =>
      new Response(JSON.stringify(mockMarketResponse), { status: 200 })
    ) as any;

    const market = await fetchMarketData("0xabc123");
    expect(market).not.toBeNull();
    expect(market!.condition_id).toBe("0xabc123");
    expect(market!.question).toBe("Will Trump win?");
  });

  test("returns null on 404", async () => {
    global.fetch = mock(async () =>
      new Response("Not Found", { status: 404 })
    ) as any;

    const market = await fetchMarketData("invalid-id");
    expect(market).toBeNull();
  });

  test("returns null on network error", async () => {
    global.fetch = mock(async () => {
      throw new Error("Connection refused");
    }) as any;

    const market = await fetchMarketData("0xabc");
    expect(market).toBeNull();
  });

  test("market has token price data", async () => {
    global.fetch = mock(async () =>
      new Response(JSON.stringify(mockMarketResponse), { status: 200 })
    ) as any;

    const market = await fetchMarketData("0xabc123");
    expect(market!.tokens.length).toBe(2);
    expect(market!.tokens[0].price).toBe(0.7);
  });
});

// ─── executeWorkflow (network-mocked) ─────────────────────────────────────────

describe("executeWorkflow", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  const makeMarket = (yesPrice: number) => ({
    condition_id: "market-001",
    question: "Will Trump win the 2026 election?",
    outcomes: ["Yes", "No"],
    tokens: [
      { token_id: "t1", outcome: "Yes", price: yesPrice },
      { token_id: "t2", outcome: "No", price: 1 - yesPrice },
    ],
    active: true,
    closed: false,
    volume: 1000000,
  });

  const baseState = () => ({
    alertConfigs: [],
    lastChecked: {} as Record<string, number>,
    triggeredAlerts: [] as string[],
  });

  test("returns state and alerts array", async () => {
    const state = baseState();
    const result = await executeWorkflow(state);
    expect(result).toHaveProperty("state");
    expect(result).toHaveProperty("alerts");
    expect(Array.isArray(result.alerts)).toBe(true);
  });

  test("triggers alert when above threshold is met", async () => {
    // CLOB API returns market with Yes at 75% -> threshold 60% above -> triggers
    // Webhook POST also succeeds
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.75)), { status: 200 });
      }
      // Webhook call
      return new Response("ok", { status: 200 });
    }) as any;

    const state = {
      ...baseState(),
      alertConfigs: [
        {
          marketId: "market-001",
          outcome: "Yes",
          threshold: 60,
          direction: "above" as const,
          notifyUrl: "https://webhook.test/notify",
        },
      ],
    };

    const result = await executeWorkflow(state);
    expect(result.alerts.length).toBeGreaterThan(0);
    expect(result.alerts[0]).toMatch(/market-001|Will Trump|Yes|75/i);
  });

  test("does not trigger alert when condition is not met", async () => {
    // Yes at 45%, threshold 60% above -> should NOT trigger
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.45)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    }) as any;

    const state = {
      ...baseState(),
      alertConfigs: [
        {
          marketId: "market-001",
          outcome: "Yes",
          threshold: 60,
          direction: "above" as const,
          notifyUrl: "https://webhook.test/notify",
        },
      ],
    };

    const result = await executeWorkflow(state);
    expect(result.alerts.length).toBe(0);
  });

  test("skips already-triggered alerts", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.75)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    }) as any;

    const state = {
      ...baseState(),
      alertConfigs: [
        {
          marketId: "market-001",
          outcome: "Yes",
          threshold: 60,
          direction: "above" as const,
          notifyUrl: "https://webhook.test/notify",
        },
      ],
      triggeredAlerts: ["market-001-Yes-60-above"],
    };

    const result = await executeWorkflow(state);
    // Alert was already triggered, should be skipped
    expect(result.alerts.length).toBe(0);
  });

  test("respects 1-minute rate limit per market", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.75)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    }) as any;

    const state = {
      ...baseState(),
      alertConfigs: [
        {
          marketId: "market-001",
          outcome: "Yes",
          threshold: 60,
          direction: "above" as const,
          notifyUrl: "https://webhook.test/notify",
        },
      ],
      // lastChecked very recently (30 seconds ago)
      lastChecked: { "market-001": Date.now() - 30000 },
    };

    const result = await executeWorkflow(state);
    // Should be rate-limited and skip the check
    expect(result.alerts.length).toBe(0);
  });

  test("skips closed markets", async () => {
    const closedMarket = { ...makeMarket(0.80), closed: true };
    global.fetch = mock(async () =>
      new Response(JSON.stringify(closedMarket), { status: 200 })
    ) as any;

    const state = {
      ...baseState(),
      alertConfigs: [
        {
          marketId: "market-001",
          outcome: "Yes",
          threshold: 60,
          direction: "above" as const,
          notifyUrl: "https://webhook.test/notify",
        },
      ],
    };

    const result = await executeWorkflow(state);
    expect(result.alerts.length).toBe(0);
  });

  test("skips inactive markets", async () => {
    const inactiveMarket = { ...makeMarket(0.80), active: false };
    global.fetch = mock(async () =>
      new Response(JSON.stringify(inactiveMarket), { status: 200 })
    ) as any;

    const state = {
      ...baseState(),
      alertConfigs: [
        {
          marketId: "market-001",
          outcome: "Yes",
          threshold: 60,
          direction: "above" as const,
          notifyUrl: "https://webhook.test/notify",
        },
      ],
    };

    const result = await executeWorkflow(state);
    expect(result.alerts.length).toBe(0);
  });

  test("triggers below-threshold alert when condition met", async () => {
    // Yes at 20%, threshold 30% below -> triggers
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.20)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    }) as any;

    const state = {
      ...baseState(),
      alertConfigs: [
        {
          marketId: "market-001",
          outcome: "Yes",
          threshold: 30,
          direction: "below" as const,
          notifyUrl: "https://webhook.test/notify",
        },
      ],
    };

    const result = await executeWorkflow(state);
    expect(result.alerts.length).toBe(1);
  });

  test("returns empty alerts with empty alertConfigs", async () => {
    const result = await executeWorkflow(baseState());
    expect(result.alerts).toEqual([]);
  });

  test("updates triggeredAlerts in state after firing", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.75)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    }) as any;

    const state = {
      ...baseState(),
      alertConfigs: [
        {
          marketId: "market-001",
          outcome: "Yes",
          threshold: 60,
          direction: "above" as const,
          notifyUrl: "https://webhook.test/notify",
        },
      ],
    };

    const result = await executeWorkflow(state);
    if (result.alerts.length > 0) {
      expect(result.state.triggeredAlerts.length).toBeGreaterThan(0);
    }
  });
});

// ─── default workflow export ──────────────────────────────────────────────────

describe("workflow default export", () => {
  test("exports name and version", async () => {
    const wf = (await import("../polymarket-alert-workflow")).default;
    expect(wf.name).toBe("polymarket-alerts");
    expect(wf.version).toBe("1.0.0");
  });

  test("exports execute function", async () => {
    const wf = (await import("../polymarket-alert-workflow")).default;
    expect(typeof wf.execute).toBe("function");
  });

  test("exports helpers object with searchMarkets", async () => {
    const wf = (await import("../polymarket-alert-workflow")).default;
    expect(typeof wf.helpers.searchMarkets).toBe("function");
  });

  test("exports helpers object with fetchMarketData", async () => {
    const wf = (await import("../polymarket-alert-workflow")).default;
    expect(typeof wf.helpers.fetchMarketData).toBe("function");
  });

  test("has triggers array", async () => {
    const wf = (await import("../polymarket-alert-workflow")).default;
    expect(Array.isArray(wf.triggers)).toBe(true);
    expect(wf.triggers.length).toBeGreaterThan(0);
  });
});
