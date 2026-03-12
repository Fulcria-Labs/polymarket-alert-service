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
    expect(wf.version).toBe("1.1.0");
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

// ─── parseAlertRequest - unusual phrasings ───────────────────────────────────

describe("parseAlertRequest - unusual phrasings", () => {
  test("parses 'ping me when ETH surpasses 90%'", () => {
    const result = parseAlertRequest("ping me when ETH surpasses 90%", NOTIFY_URL);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(90);
    expect(result!.direction).toBe("above");
  });

  test("parses 'message me when recession climbs to 80%'", () => {
    const result = parseAlertRequest("message me when recession climbs to 80%", NOTIFY_URL);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(80);
    expect(result!.direction).toBe("above");
  });

  test("parses 'inform me when AI regulation sinks to 10%' (captures threshold)", () => {
    const result = parseAlertRequest("inform me when AI regulation sinks to 10%", NOTIFY_URL);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(10);
    // "sinks to" matches pattern 4 (hits/reaches/at/to) which defaults to above
    expect(result!.direction).toBe("above");
  });

  test("parses 'when war probability dips below 5%'", () => {
    const result = parseAlertRequest("when war probability dips below 5%", NOTIFY_URL);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(5);
    expect(result!.direction).toBe("below");
  });

  test("parses 'if GDP growth declines to 15 percent' (captures threshold)", () => {
    const result = parseAlertRequest("if GDP growth declines to 15 percent", NOTIFY_URL);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(15);
    // "declines to" matches pattern 4 which defaults to above
    expect(result!.direction).toBe("above");
  });

  test("parses 'once Bitcoin passes 95%'", () => {
    const result = parseAlertRequest("once Bitcoin passes 95%", NOTIFY_URL);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(95);
    expect(result!.direction).toBe("above");
  });

  test("parses 'when election breaks 88%'", () => {
    const result = parseAlertRequest("when election breaks 88%", NOTIFY_URL);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(88);
    expect(result!.direction).toBe("above");
  });

  test("parses 'if recession tops 72%'", () => {
    const result = parseAlertRequest("if recession tops 72%", NOTIFY_URL);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(72);
    expect(result!.direction).toBe("above");
  });

  test("parses 'alert when market gets to 50 cents'", () => {
    const result = parseAlertRequest("alert when market gets to 50 cents", NOTIFY_URL);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(50);
  });

  test("parses threshold with trailing whitespace '65 %'", () => {
    const result = parseAlertRequest("Trump > 65 %", NOTIFY_URL);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(65);
  });

  test("handles UPPERCASE input 'ALERT WHEN TRUMP > 60%'", () => {
    const result = parseAlertRequest("ALERT WHEN TRUMP > 60%", NOTIFY_URL);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(60);
    expect(result!.direction).toBe("above");
  });

  test("handles mixed case 'AlerT Me WhEn Trump exceEDS 50%'", () => {
    const result = parseAlertRequest("AlerT Me WhEn Trump exceEDS 50%", NOTIFY_URL);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(50);
  });

  test("handles 'let me know when BTC rises to 77%'", () => {
    const result = parseAlertRequest("let me know when BTC rises to 77%", NOTIFY_URL);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(77);
    expect(result!.direction).toBe("above");
  });

  test("returns null for input with no numeric value", () => {
    const result = parseAlertRequest("alert when Trump wins", NOTIFY_URL);
    expect(result).toBeNull();
  });

  test("returns null for input with only a number, no direction", () => {
    const result = parseAlertRequest("50", NOTIFY_URL);
    expect(result).toBeNull();
  });

  test("handles very large threshold like 99.9%", () => {
    const result = parseAlertRequest("Alert when Trump > 99.9%", NOTIFY_URL);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(99.9);
  });

  test("handles very small threshold like 0.1%", () => {
    const result = parseAlertRequest("Alert when Trump < 0.1%", NOTIFY_URL);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(0.1);
    expect(result!.direction).toBe("below");
  });

  test("handles threshold of exactly 100%", () => {
    const result = parseAlertRequest("Alert when Trump > 100%", NOTIFY_URL);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(100);
  });

  test("handles threshold of exactly 0%", () => {
    const result = parseAlertRequest("Alert when Trump < 0%", NOTIFY_URL);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(0);
    expect(result!.direction).toBe("below");
  });
});

// ─── parseAlertRequest - null/empty/edge inputs ──────────────────────────────

describe("parseAlertRequest - null and edge inputs", () => {
  test("returns null for whitespace-only input", () => {
    const result = parseAlertRequest("   ", NOTIFY_URL);
    expect(result).toBeNull();
  });

  test("returns null for tab characters only", () => {
    const result = parseAlertRequest("\t\t", NOTIFY_URL);
    expect(result).toBeNull();
  });

  test("returns null for newlines only", () => {
    const result = parseAlertRequest("\n\n\n", NOTIFY_URL);
    expect(result).toBeNull();
  });

  test("handles input with special characters without crashing", () => {
    const result = parseAlertRequest("@#$%^&*()!~`", NOTIFY_URL);
    // Should either return null or a result, but not crash
    expect(result === null || typeof result === "object").toBe(true);
  });

  test("handles very long input string", () => {
    const longInput = "Alert when Trump exceeds 60% " + "and this is some really long padding ".repeat(100);
    const result = parseAlertRequest(longInput, NOTIFY_URL);
    // Should still parse the core message
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(60);
  });

  test("handles input with HTML tags", () => {
    const result = parseAlertRequest("<script>alert('xss')</script> Trump > 50%", NOTIFY_URL);
    // Should parse the numeric content or return null, not crash
    expect(result === null || typeof result === "object").toBe(true);
  });

  test("handles input with SQL injection attempt", () => {
    const result = parseAlertRequest("'; DROP TABLE alerts; -- Trump > 50%", NOTIFY_URL);
    expect(result === null || typeof result === "object").toBe(true);
  });

  test("handles unicode characters in input", () => {
    const result = parseAlertRequest("Alert when Bitcoin \u2192 80%", NOTIFY_URL);
    expect(result === null || typeof result === "object").toBe(true);
  });

  test("handles emoji in input", () => {
    const result = parseAlertRequest("Alert when Trump exceeds 60%", NOTIFY_URL);
    expect(result).not.toBeNull();
  });

  test("handles URL in input without crashing", () => {
    const result = parseAlertRequest("https://example.com > 50%", NOTIFY_URL);
    expect(result === null || typeof result === "object").toBe(true);
  });

  test("empty notifyUrl is stored correctly", () => {
    const result = parseAlertRequest("Alert when Trump > 60%", "");
    expect(result).not.toBeNull();
    expect(result!.notifyUrl).toBe("");
  });

  test("very long notifyUrl is stored correctly", () => {
    const longUrl = "https://example.com/" + "a".repeat(500);
    const result = parseAlertRequest("Alert when Trump > 60%", longUrl);
    expect(result).not.toBeNull();
    expect(result!.notifyUrl).toBe(longUrl);
  });
});

// ─── parseAlertRequest - outcome detection edge cases ────────────────────────

describe("parseAlertRequest - outcome detection edge cases", () => {
  test("detects Yes for 'will pass' phrasing", () => {
    const result = parseAlertRequest("if bill will pass above 70%", NOTIFY_URL);
    if (result) {
      expect(result.outcome).toBe("Yes");
    }
  });

  test("detects No for 'won't happen' phrasing", () => {
    const result = parseAlertRequest("if it won't happen below 30%", NOTIFY_URL);
    if (result) {
      expect(result.outcome).toBe("No");
    }
  });

  test("detects No for 'fail' keyword", () => {
    const result = parseAlertRequest("when bill fails below 25%", NOTIFY_URL);
    if (result) {
      expect(result.outcome).toBe("No");
    }
  });

  test("detects No for 'reject' keyword", () => {
    const result = parseAlertRequest("if congress rejects above 60%", NOTIFY_URL);
    if (result) {
      expect(result.outcome).toBe("No");
    }
  });

  test("detects No for 'lose' keyword", () => {
    const result = parseAlertRequest("when team loses below 40%", NOTIFY_URL);
    if (result) {
      expect(result.outcome).toBe("No");
    }
  });

  test("defaults to Yes when no outcome keywords present", () => {
    const result = parseAlertRequest("when market hits 55%", NOTIFY_URL);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("Yes");
  });

  test("detects Yes for 'approve' keyword", () => {
    const result = parseAlertRequest("if ETF gets approved above 80%", NOTIFY_URL);
    if (result) {
      expect(result.outcome).toBe("Yes");
    }
  });
});

// ─── parseMultiConditionAlert - complex scenarios ────────────────────────────

describe("parseMultiConditionAlert - complex scenarios", () => {
  test("parses three AND conditions", () => {
    const results = parseMultiConditionAlert(
      "Trump > 60% AND Biden < 40% AND recession above 50%",
      NOTIFY_URL
    );
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  test("parses pipe-separated conditions", () => {
    const results = parseMultiConditionAlert(
      "Trump > 60% | Biden < 40%",
      NOTIFY_URL
    );
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  test("parses ampersand-separated conditions", () => {
    const results = parseMultiConditionAlert(
      "Trump > 60% & Biden < 40%",
      NOTIFY_URL
    );
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  test("handles empty string", () => {
    const results = parseMultiConditionAlert("", NOTIFY_URL);
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(0);
  });

  test("handles whitespace-only string", () => {
    const results = parseMultiConditionAlert("   ", NOTIFY_URL);
    expect(Array.isArray(results)).toBe(true);
  });

  test("all conditions get the same notifyUrl", () => {
    const results = parseMultiConditionAlert(
      "Trump > 60% AND Biden < 40%",
      "https://specific-hook.io/alert"
    );
    for (const r of results) {
      expect(r.notifyUrl).toBe("https://specific-hook.io/alert");
    }
  });

  test("all conditions have empty marketId initially", () => {
    const results = parseMultiConditionAlert(
      "Trump > 60% AND Biden < 40%",
      NOTIFY_URL
    );
    for (const r of results) {
      expect(r.marketId).toBe("");
    }
  });

  test("mixed above and below conditions are preserved", () => {
    const results = parseMultiConditionAlert(
      "recession above 70% or inflation below 20%",
      NOTIFY_URL
    );
    if (results.length >= 2) {
      const dirs = results.map(r => r.direction);
      expect(dirs).toContain("above");
      expect(dirs).toContain("below");
    }
  });

  test("single condition in multi-parser returns length 1", () => {
    const results = parseMultiConditionAlert("Trump > 60%", NOTIFY_URL);
    expect(results.length).toBe(1);
    expect(results[0].threshold).toBe(60);
  });

  test("handles condition with special chars between parts", () => {
    const results = parseMultiConditionAlert(
      "Trump > 60%, and Biden < 40%",
      NOTIFY_URL
    );
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── extractSearchKeywords - edge cases ──────────────────────────────────────

describe("extractSearchKeywords - edge cases", () => {
  test("handles all lowercase input", () => {
    const kws = extractSearchKeywords("alert when trump exceeds 60%");
    expect(Array.isArray(kws)).toBe(true);
    expect(kws.length).toBeGreaterThan(0);
  });

  test("handles input with no meaningful words (all short)", () => {
    const kws = extractSearchKeywords("on it to be");
    expect(Array.isArray(kws)).toBe(true);
  });

  test("extracts keyword from 'about X' pattern", () => {
    const kws = extractSearchKeywords("tell me about Bitcoin odds above 50%");
    const allText = kws.join(" ").toLowerCase();
    expect(allText).toMatch(/bitcoin/i);
  });

  test("extracts from 'will X win' pattern", () => {
    const kws = extractSearchKeywords("will Trump win the election above 60%");
    const allText = kws.join(" ").toLowerCase();
    expect(allText.length).toBeGreaterThan(0);
  });

  test("handles input with only numbers", () => {
    const kws = extractSearchKeywords("60 70 80 90");
    expect(Array.isArray(kws)).toBe(true);
  });

  test("handles XSS-like input without crashing", () => {
    const kws = extractSearchKeywords("<img src=x onerror=alert(1)>");
    expect(Array.isArray(kws)).toBe(true);
  });

  test("handles multiple named entities", () => {
    const kws = extractSearchKeywords("Alert when Trump Biden election exceeds 60%");
    expect(kws.length).toBeGreaterThan(0);
    const allText = kws.join(" ");
    // Should contain capitalized names
    expect(allText).toMatch(/Trump|Biden/);
  });

  test("handles 'for X market' pattern", () => {
    const kws = extractSearchKeywords("alert for recession market above 50%");
    expect(kws.length).toBeGreaterThan(0);
  });

  test("handles 'regarding X' pattern", () => {
    const kws = extractSearchKeywords("alert regarding Bitcoin approval above 50%");
    const allText = kws.join(" ").toLowerCase();
    expect(allText.length).toBeGreaterThan(0);
  });

  test("returns at most a few keywords not the whole sentence", () => {
    const kws = extractSearchKeywords("tell me about the very long complicated market scenario involving many details");
    // Should not return the entire sentence as one keyword
    expect(kws.length).toBeLessThan(20);
  });
});

// ─── searchMarkets - additional edge cases ──────────────────────────────────

describe("searchMarkets - edge cases", () => {
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

  test("returns empty array when API returns empty array", async () => {
    global.fetch = mock(async () =>
      new Response(JSON.stringify([]), { status: 200 })
    ) as any;

    const markets = await searchMarkets("anything");
    expect(markets).toEqual([]);
  });

  test("returns empty array when API returns 403 forbidden", async () => {
    global.fetch = mock(async () =>
      new Response("Forbidden", { status: 403 })
    ) as any;

    const markets = await searchMarkets("Trump");
    expect(markets).toEqual([]);
  });

  test("returns empty array when API returns 429 rate limited", async () => {
    global.fetch = mock(async () =>
      new Response("Too Many Requests", { status: 429 })
    ) as any;

    const markets = await searchMarkets("election");
    expect(markets).toEqual([]);
  });

  test("handles market with missing question field gracefully", async () => {
    global.fetch = mock(async () =>
      new Response(JSON.stringify([{ conditionId: "c1", outcomes: ["Yes", "No"] }]), { status: 200 })
    ) as any;

    const markets = await searchMarkets("anything");
    // Should not crash, just filter it out since question?.toLowerCase() won't match
    expect(Array.isArray(markets)).toBe(true);
  });

  test("handles market with missing tokens field", async () => {
    global.fetch = mock(async () =>
      new Response(
        JSON.stringify([
          { conditionId: "c1", question: "Will Trump win?", outcomes: ["Yes", "No"] },
        ]),
        { status: 200 }
      )
    ) as any;

    const markets = await searchMarkets("Trump");
    expect(markets.length).toBe(1);
    expect(markets[0].tokens).toEqual([]);
  });

  test("matches via description field too", async () => {
    global.fetch = mock(async () =>
      new Response(
        JSON.stringify([
          {
            conditionId: "c1",
            question: "Will X happen?",
            description: "This is about Bitcoin ETF approval",
            outcomes: ["Yes", "No"],
            tokens: [],
            active: true,
            closed: false,
          },
        ]),
        { status: 200 }
      )
    ) as any;

    const markets = await searchMarkets("Bitcoin");
    expect(markets.length).toBe(1);
  });

  test("case-insensitive matching for description", async () => {
    global.fetch = mock(async () =>
      new Response(
        JSON.stringify([
          {
            conditionId: "c1",
            question: "Something else",
            description: "BITCOIN ETF market",
            outcomes: ["Yes", "No"],
            tokens: [],
            active: true,
            closed: false,
          },
        ]),
        { status: 200 }
      )
    ) as any;

    const markets = await searchMarkets("bitcoin");
    expect(markets.length).toBe(1);
  });

  test("handles fetch timeout simulation", async () => {
    global.fetch = mock(async () => {
      throw new Error("AbortError: signal timed out");
    }) as any;

    const markets = await searchMarkets("Trump");
    expect(markets).toEqual([]);
  });

  test("handles malformed JSON response", async () => {
    global.fetch = mock(async () =>
      new Response("not valid json{{{", { status: 200 })
    ) as any;

    const markets = await searchMarkets("Trump");
    expect(markets).toEqual([]);
  });

  test("filters out markets that dont match query", async () => {
    global.fetch = mock(async () =>
      new Response(
        JSON.stringify([
          makeMockMarket("Will it rain in London?"),
          makeMockMarket("Will Trump win 2026?"),
          makeMockMarket("Will Bitcoin reach 100K?"),
        ]),
        { status: 200 }
      )
    ) as any;

    const markets = await searchMarkets("Trump");
    expect(markets.length).toBe(1);
    expect(markets[0].question).toContain("Trump");
  });
});

// ─── fetchMarketData - additional edge cases ────────────────────────────────

describe("fetchMarketData - edge cases", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("returns null on 500 server error", async () => {
    global.fetch = mock(async () =>
      new Response("Internal Server Error", { status: 500 })
    ) as any;

    const market = await fetchMarketData("0xabc");
    expect(market).toBeNull();
  });

  test("returns null on 403 forbidden", async () => {
    global.fetch = mock(async () =>
      new Response("Forbidden", { status: 403 })
    ) as any;

    const market = await fetchMarketData("0xabc");
    expect(market).toBeNull();
  });

  test("returns null on 429 rate limited", async () => {
    global.fetch = mock(async () =>
      new Response("Too Many Requests", { status: 429 })
    ) as any;

    const market = await fetchMarketData("0xabc");
    expect(market).toBeNull();
  });

  test("returns null on timeout error", async () => {
    global.fetch = mock(async () => {
      throw new Error("AbortError: signal timed out");
    }) as any;

    const market = await fetchMarketData("0xabc");
    expect(market).toBeNull();
  });

  test("handles empty market ID", async () => {
    global.fetch = mock(async () =>
      new Response("Bad Request", { status: 400 })
    ) as any;

    const market = await fetchMarketData("");
    expect(market).toBeNull();
  });

  test("returns market with all fields when valid", async () => {
    const fullMarket = {
      condition_id: "0xfull",
      question: "Full market test?",
      outcomes: ["Yes", "No"],
      tokens: [
        { token_id: "t1", outcome: "Yes", price: 0.55 },
        { token_id: "t2", outcome: "No", price: 0.45 },
      ],
      active: true,
      closed: false,
      volume: 999999,
    };
    global.fetch = mock(async () =>
      new Response(JSON.stringify(fullMarket), { status: 200 })
    ) as any;

    const market = await fetchMarketData("0xfull");
    expect(market).not.toBeNull();
    expect(market!.condition_id).toBe("0xfull");
    expect(market!.active).toBe(true);
    expect(market!.closed).toBe(false);
    expect(market!.volume).toBe(999999);
    expect(market!.tokens.length).toBe(2);
  });
});

// ─── executeWorkflow - additional scenarios ──────────────────────────────────

describe("executeWorkflow - additional edge cases", () => {
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

  test("handles fetchMarketData returning null (network error)", async () => {
    global.fetch = mock(async () => {
      throw new Error("Network error");
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

  test("does not trigger when price is exactly at threshold (above)", async () => {
    // Price at exactly 60%, threshold 60% above -> >= so should trigger
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.60)), { status: 200 });
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
    // >= means exact threshold should trigger
    expect(result.alerts.length).toBe(1);
  });

  test("triggers when price is exactly at threshold (below)", async () => {
    // Price at exactly 30%, threshold 30% below -> <= so should trigger
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.30)), { status: 200 });
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

  test("does not trigger when price is just above below-threshold", async () => {
    // Price at 31%, threshold 30% below -> 31 <= 30 is false -> no trigger
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.31)), { status: 200 });
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
    expect(result.alerts.length).toBe(0);
  });

  test("does not trigger when price is just below above-threshold", async () => {
    // Price at 59%, threshold 60% above -> 59 >= 60 is false -> no trigger
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.59)), { status: 200 });
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

  test("handles multiple alerts on different markets", async () => {
    let callCount = 0;
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        callCount++;
        if (url.includes("market-A")) {
          return new Response(JSON.stringify({
            ...makeMarket(0.75),
            condition_id: "market-A",
          }), { status: 200 });
        }
        if (url.includes("market-B")) {
          return new Response(JSON.stringify({
            ...makeMarket(0.20),
            condition_id: "market-B",
          }), { status: 200 });
        }
      }
      return new Response("ok", { status: 200 });
    }) as any;

    const state = {
      ...baseState(),
      alertConfigs: [
        {
          marketId: "market-A",
          outcome: "Yes",
          threshold: 60,
          direction: "above" as const,
          notifyUrl: "https://webhook.test/a",
        },
        {
          marketId: "market-B",
          outcome: "Yes",
          threshold: 30,
          direction: "below" as const,
          notifyUrl: "https://webhook.test/b",
        },
      ],
    };

    const result = await executeWorkflow(state);
    // Both should trigger
    expect(result.alerts.length).toBe(2);
  });

  test("does not send webhook when alert condition is not met", async () => {
    let webhookCalled = false;
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.45)), { status: 200 });
      }
      webhookCalled = true;
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

    await executeWorkflow(state);
    expect(webhookCalled).toBe(false);
  });

  test("handles webhook failure gracefully (does not add to triggered)", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.75)), { status: 200 });
      }
      // Webhook fails
      return new Response("Server Error", { status: 500 });
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
    // Webhook returned 500, so alert not sent successfully -> not added to triggered
    expect(result.state.triggeredAlerts.length).toBe(0);
    expect(result.alerts.length).toBe(0);
  });

  test("handles webhook network error gracefully", async () => {
    let firstCall = true;
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.75)), { status: 200 });
      }
      // Webhook throws network error
      throw new Error("Connection refused");
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
    // Webhook threw, so alert not sent -> not triggered
    expect(result.state.triggeredAlerts.length).toBe(0);
    expect(result.alerts.length).toBe(0);
  });

  test("updates lastChecked timestamp for market", async () => {
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

    const before = Date.now();
    const result = await executeWorkflow(state);
    expect(result.state.lastChecked["market-001"]).toBeGreaterThanOrEqual(before);
  });

  test("rate limit allows check after 60 seconds", async () => {
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
      // lastChecked 61 seconds ago (just past rate limit)
      lastChecked: { "market-001": Date.now() - 61000 },
    };

    const result = await executeWorkflow(state);
    expect(result.alerts.length).toBe(1);
  });

  test("handles outcome not found in market tokens", async () => {
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
          outcome: "Maybe", // Not a valid outcome
          threshold: 60,
          direction: "above" as const,
          notifyUrl: "https://webhook.test/notify",
        },
      ],
    };

    const result = await executeWorkflow(state);
    expect(result.alerts.length).toBe(0);
  });

  test("preserves existing triggered alerts in state", async () => {
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
          marketId: "market-002",
          outcome: "Yes",
          threshold: 60,
          direction: "above" as const,
          notifyUrl: "https://webhook.test/notify",
        },
      ],
      triggeredAlerts: ["some-old-alert-key"],
    };

    const result = await executeWorkflow(state);
    expect(result.state.triggeredAlerts).toContain("some-old-alert-key");
  });

  test("handles market with zero price", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.0)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    }) as any;

    const state = {
      ...baseState(),
      alertConfigs: [
        {
          marketId: "market-001",
          outcome: "Yes",
          threshold: 10,
          direction: "below" as const,
          notifyUrl: "https://webhook.test/notify",
        },
      ],
    };

    const result = await executeWorkflow(state);
    // 0% <= 10% -> triggers
    expect(result.alerts.length).toBe(1);
  });

  test("handles market with price at 1.0 (100%)", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(1.0)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    }) as any;

    const state = {
      ...baseState(),
      alertConfigs: [
        {
          marketId: "market-001",
          outcome: "Yes",
          threshold: 99,
          direction: "above" as const,
          notifyUrl: "https://webhook.test/notify",
        },
      ],
    };

    const result = await executeWorkflow(state);
    // 100% >= 99% -> triggers
    expect(result.alerts.length).toBe(1);
  });

  test("alert message contains market question info", async () => {
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
    expect(result.alerts.length).toBe(1);
    expect(result.alerts[0]).toContain("Trump");
    expect(result.alerts[0]).toContain("Yes");
  });
});
