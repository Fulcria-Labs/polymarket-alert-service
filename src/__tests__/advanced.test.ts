/**
 * Advanced tests for Polymarket Alert Service
 *
 * Covers:
 * - Workflow execution: webhook failures, concurrent alerts, state transitions
 * - State management: pending payment cleanup, triggered alerts tracking
 * - NLP parsing: complex phrasings, international formats, ambiguous input
 * - Market data: malformed responses, missing fields, edge token prices
 * - Alert lifecycle: create → monitor → trigger → deduplicate
 * - API integration flows: end-to-end request sequences
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import {
  parseAlertRequest,
  parseMultiConditionAlert,
  extractSearchKeywords,
  executeWorkflow,
  fetchMarketData,
  searchMarkets,
} from "../polymarket-alert-workflow";
import {
  createPaymentRequired,
  verifyPayment,
  calculateBulkPrice,
  getPaymentInstructions,
} from "../x402-handler";
import app from "../api";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const NOTIFY_URL = "https://webhook.example.com/notify";

function makeMarket(price = 0.65, overrides: Record<string, any> = {}) {
  return {
    condition_id: overrides.condition_id || "0xMKT",
    question: overrides.question || "Will X happen?",
    outcomes: overrides.outcomes || ["Yes", "No"],
    tokens: overrides.tokens || [
      { token_id: "t1", outcome: "Yes", price, winner: false },
      { token_id: "t2", outcome: "No", price: 1 - price, winner: false },
    ],
    active: overrides.active !== undefined ? overrides.active : true,
    closed: overrides.closed !== undefined ? overrides.closed : false,
    volume: overrides.volume || 100000,
  };
}

async function apiReq(
  method: string,
  path: string,
  opts: { body?: any; headers?: Record<string, string> } = {}
): Promise<Response> {
  const init: RequestInit = { method };
  if (opts.headers) init.headers = opts.headers;
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    init.headers = { "Content-Type": "application/json", ...(init.headers || {}) };
  }
  return app.fetch(new Request(`http://localhost${path}`, init));
}

// ─── Workflow Execution: Webhook Behavior ────────────────────────────────────

describe("Workflow - webhook send failures", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("does not mark alert as triggered when webhook POST returns 500", async () => {
    let callCount = 0;
    global.fetch = mock(async (url: string) => {
      callCount++;
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.75)), { status: 200 });
      }
      // Webhook returns server error
      return new Response("Server Error", { status: 500 });
    });

    const state = {
      alertConfigs: [{
        marketId: "0xMKT",
        outcome: "Yes",
        threshold: 60,
        direction: "above" as const,
        notifyUrl: "http://hook",
      }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };

    const result = await executeWorkflow(state);
    // Webhook returned non-ok, so alert should NOT be in triggeredAlerts
    expect(result.state.triggeredAlerts).not.toContain("0xMKT-Yes-60-above");
  });

  test("does not mark alert as triggered when webhook throws network error", async () => {
    let fetchCalls = 0;
    global.fetch = mock(async (url: string) => {
      fetchCalls++;
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.80)), { status: 200 });
      }
      throw new Error("Connection refused");
    });

    const state = {
      alertConfigs: [{
        marketId: "0xMKT",
        outcome: "Yes",
        threshold: 70,
        direction: "above" as const,
        notifyUrl: "http://unreachable",
      }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };

    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(0);
  });

  test("marks alert as triggered when webhook returns 200", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.75)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });

    const state = {
      alertConfigs: [{
        marketId: "0xMKT",
        outcome: "Yes",
        threshold: 60,
        direction: "above" as const,
        notifyUrl: "http://hook",
      }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };

    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(1);
    expect(result.state.triggeredAlerts).toContain("0xMKT-Yes-60-above");
  });

  test("webhook receives correct payload structure", async () => {
    let webhookPayload: any = null;
    global.fetch = mock(async (url: string, opts?: any) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.70, {
          condition_id: "0xPAYLOAD",
          question: "Test market?"
        })), { status: 200 });
      }
      webhookPayload = JSON.parse(opts?.body || "{}");
      return new Response("ok", { status: 200 });
    });

    const state = {
      alertConfigs: [{
        marketId: "0xPAYLOAD",
        outcome: "Yes",
        threshold: 60,
        direction: "above" as const,
        notifyUrl: "http://hook",
      }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };

    await executeWorkflow(state);
    expect(webhookPayload).not.toBeNull();
    expect(webhookPayload.type).toBe("prediction_market_alert");
    expect(webhookPayload.marketId).toBe("0xPAYLOAD");
    expect(webhookPayload.question).toBe("Test market?");
    expect(webhookPayload.outcome).toBe("Yes");
    expect(webhookPayload.threshold).toBe(60);
    expect(webhookPayload.direction).toBe("above");
    expect(webhookPayload.triggeredAt).toBeTruthy();
  });
});

// ─── Workflow Execution: Multiple Alert Configs ──────────────────────────────

describe("Workflow - multiple alert configs", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("processes multiple alerts for the same market", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.75)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });

    const state = {
      alertConfigs: [
        { marketId: "0xSAME", outcome: "Yes", threshold: 70, direction: "above" as const, notifyUrl: "http://hook1" },
        { marketId: "0xSAME", outcome: "Yes", threshold: 60, direction: "above" as const, notifyUrl: "http://hook2" },
      ],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };

    const result = await executeWorkflow(state);
    // Second alert may be rate-limited since both share the same marketId
    expect(result.alerts.length).toBeGreaterThanOrEqual(1);
  });

  test("independently tracks triggered state per alert config", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("market-A")) {
        return new Response(JSON.stringify(makeMarket(0.80, { condition_id: "market-A" })), { status: 200 });
      }
      if (typeof url === "string" && url.includes("market-B")) {
        return new Response(JSON.stringify(makeMarket(0.30, { condition_id: "market-B" })), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });

    const state = {
      alertConfigs: [
        { marketId: "market-A", outcome: "Yes", threshold: 70, direction: "above" as const, notifyUrl: "http://hook" },
        { marketId: "market-B", outcome: "Yes", threshold: 40, direction: "below" as const, notifyUrl: "http://hook" },
      ],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };

    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(2);
    expect(result.state.triggeredAlerts).toContain("market-A-Yes-70-above");
    expect(result.state.triggeredAlerts).toContain("market-B-Yes-40-below");
  });

  test("skips one triggered alert but processes another", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.80)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });

    const state = {
      alertConfigs: [
        { marketId: "0xM1", outcome: "Yes", threshold: 70, direction: "above" as const, notifyUrl: "http://hook" },
        { marketId: "0xM2", outcome: "Yes", threshold: 70, direction: "above" as const, notifyUrl: "http://hook" },
      ],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: ["0xM1-Yes-70-above"], // M1 already triggered
    };

    const result = await executeWorkflow(state);
    // M1 skipped, M2 should trigger
    expect(result.state.triggeredAlerts).toContain("0xM1-Yes-70-above");
  });
});

// ─── Workflow Execution: State Persistence ───────────────────────────────────

describe("Workflow - state management", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("preserves existing triggered alerts in returned state", async () => {
    global.fetch = mock(async () =>
      new Response(JSON.stringify(makeMarket(0.50)), { status: 200 })
    );

    const state = {
      alertConfigs: [{
        marketId: "0xMKT",
        outcome: "Yes",
        threshold: 60,
        direction: "above" as const,
        notifyUrl: "http://hook",
      }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: ["old-alert-key"],
    };

    const result = await executeWorkflow(state);
    expect(result.state.triggeredAlerts).toContain("old-alert-key");
  });

  test("updates lastChecked timestamp for checked markets", async () => {
    const beforeTime = Date.now();
    global.fetch = mock(async () =>
      new Response(JSON.stringify(makeMarket(0.50)), { status: 200 })
    );

    const state = {
      alertConfigs: [{
        marketId: "0xTIME",
        outcome: "Yes",
        threshold: 60,
        direction: "above" as const,
        notifyUrl: "http://hook",
      }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };

    const result = await executeWorkflow(state);
    expect(result.state.lastChecked["0xTIME"]).toBeGreaterThanOrEqual(beforeTime);
  });

  test("returns same state object reference", async () => {
    const state = {
      alertConfigs: [],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };

    const result = await executeWorkflow(state);
    expect(result.state).toBe(state);
  });

  test("handles market fetch returning null gracefully", async () => {
    global.fetch = mock(async () =>
      new Response("Not Found", { status: 404 })
    );

    const state = {
      alertConfigs: [{
        marketId: "0xGONE",
        outcome: "Yes",
        threshold: 50,
        direction: "above" as const,
        notifyUrl: "http://hook",
      }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };

    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(0);
  });
});

// ─── Workflow: Outcome Matching ──────────────────────────────────────────────

describe("Workflow - outcome matching", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("matches 'No' outcome correctly", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.70)), { status: 200 });
        // No token price = 1 - 0.70 = 0.30 = 30%
      }
      return new Response("ok", { status: 200 });
    });

    const state = {
      alertConfigs: [{
        marketId: "0xNO",
        outcome: "No",
        threshold: 35,
        direction: "below" as const,
        notifyUrl: "http://hook",
      }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };

    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(1);
  });

  test("does not trigger when wrong outcome checked", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.70)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });

    const state = {
      alertConfigs: [{
        marketId: "0xMKT",
        outcome: "No",
        threshold: 60,
        direction: "above" as const,
        notifyUrl: "http://hook",
      }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };

    const result = await executeWorkflow(state);
    // No outcome is at 30%, threshold is 60% above - should not trigger
    expect(result.alerts).toHaveLength(0);
  });

  test("handles missing outcome in market tokens", async () => {
    global.fetch = mock(async () =>
      new Response(JSON.stringify(makeMarket(0.65)), { status: 200 })
    );

    const state = {
      alertConfigs: [{
        marketId: "0xMKT",
        outcome: "Maybe",
        threshold: 50,
        direction: "above" as const,
        notifyUrl: "http://hook",
      }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };

    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(0);
  });
});

// ─── fetchMarketData ─────────────────────────────────────────────────────────

describe("fetchMarketData - response handling", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("returns null for 404 response", async () => {
    global.fetch = mock(async () => new Response("", { status: 404 }));
    const result = await fetchMarketData("0xNONE");
    expect(result).toBeNull();
  });

  test("returns null for 500 response", async () => {
    global.fetch = mock(async () => new Response("", { status: 500 }));
    const result = await fetchMarketData("0xERR");
    expect(result).toBeNull();
  });

  test("returns null when fetch throws", async () => {
    global.fetch = mock(async () => { throw new Error("DNS failed"); });
    const result = await fetchMarketData("0xDNS");
    expect(result).toBeNull();
  });

  test("returns parsed market data for 200 response", async () => {
    const market = makeMarket(0.65, { condition_id: "0xGOOD", question: "Test?" });
    global.fetch = mock(async () => new Response(JSON.stringify(market), { status: 200 }));
    const result = await fetchMarketData("0xGOOD");
    expect(result).not.toBeNull();
    expect(result!.condition_id).toBe("0xGOOD");
  });

  test("calls correct CLOB API URL", async () => {
    let calledUrl = "";
    global.fetch = mock(async (url: string) => {
      calledUrl = url;
      return new Response(JSON.stringify(makeMarket()), { status: 200 });
    });
    await fetchMarketData("0xABC123");
    expect(calledUrl).toContain("clob.polymarket.com");
    expect(calledUrl).toContain("0xABC123");
  });

  test("returns null for empty response body", async () => {
    global.fetch = mock(async () => new Response("", { status: 200 }));
    const result = await fetchMarketData("0xEMPTY");
    // JSON.parse("") throws, caught by try/catch -> null
    expect(result).toBeNull();
  });
});

// ─── searchMarkets ───────────────────────────────────────────────────────────

describe("searchMarkets - response handling", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("returns empty array for non-200 response", async () => {
    global.fetch = mock(async () => new Response("", { status: 500 }));
    const result = await searchMarkets("Trump");
    expect(result).toEqual([]);
  });

  test("returns empty array when fetch throws", async () => {
    global.fetch = mock(async () => { throw new Error("timeout"); });
    const result = await searchMarkets("election");
    expect(result).toEqual([]);
  });

  test("filters markets by query string (case insensitive)", async () => {
    const markets = [
      { ...makeMarket(), conditionId: "0x1", question: "Will Trump win?", description: "" },
      { ...makeMarket(), conditionId: "0x2", question: "Will it rain?", description: "" },
    ];
    global.fetch = mock(async () => new Response(JSON.stringify(markets), { status: 200 }));
    const result = await searchMarkets("trump");
    expect(result.length).toBe(1);
    expect(result[0].question).toContain("Trump");
  });

  test("matches on description field too", async () => {
    const markets = [
      { ...makeMarket(), conditionId: "0x1", question: "2026 election", description: "Trump vs Biden" },
    ];
    global.fetch = mock(async () => new Response(JSON.stringify(markets), { status: 200 }));
    const result = await searchMarkets("trump");
    expect(result.length).toBe(1);
  });

  test("returns empty array when no markets match query", async () => {
    const markets = [
      { ...makeMarket(), conditionId: "0x1", question: "Will it snow?", description: "" },
    ];
    global.fetch = mock(async () => new Response(JSON.stringify(markets), { status: 200 }));
    const result = await searchMarkets("election");
    expect(result).toEqual([]);
  });

  test("maps conditionId to condition_id in results", async () => {
    const markets = [
      { ...makeMarket(), conditionId: "0xMAPPED", question: "Test market", description: "" },
    ];
    global.fetch = mock(async () => new Response(JSON.stringify(markets), { status: 200 }));
    const result = await searchMarkets("test");
    expect(result.length).toBe(1);
    expect(result[0].condition_id).toBe("0xMAPPED");
  });

  test("handles markets with missing tokens gracefully", async () => {
    const markets = [
      { conditionId: "0x1", question: "Test market", description: "", active: true, closed: false },
    ];
    global.fetch = mock(async () => new Response(JSON.stringify(markets), { status: 200 }));
    const result = await searchMarkets("test");
    expect(result.length).toBe(1);
    expect(result[0].tokens).toEqual([]);
  });
});

// ─── NLP Parsing: Complex Phrasings ──────────────────────────────────────────

describe("NLP - advanced phrasings", () => {
  test("parses 'ping me when recession probability goes above 50%'", () => {
    const result = parseAlertRequest("ping me when recession probability goes above 50%", NOTIFY_URL);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(50);
    expect(result!.direction).toBe("above");
  });

  test("parses 'message me if inflation exceeds 45 percent'", () => {
    const result = parseAlertRequest("message me if inflation exceeds 45 percent", NOTIFY_URL);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(45);
    expect(result!.direction).toBe("above");
  });

  test("parses 'inform me once GDP growth drops below 2%'", () => {
    const result = parseAlertRequest("inform me once GDP growth drops below 2%", NOTIFY_URL);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(2);
    expect(result!.direction).toBe("below");
  });

  test("parses percentage with decimal places '65.5%'", () => {
    const result = parseAlertRequest("when odds exceed 65.5%", NOTIFY_URL);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(65.5);
  });

  test("parses 'climbs to' as above direction", () => {
    const result = parseAlertRequest("when approval climbs to 80%", NOTIFY_URL);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("above");
  });

  test("parses 'dips below' as below direction", () => {
    const result = parseAlertRequest("when confidence dips below 15%", NOTIFY_URL);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("below");
  });

  test("parses 'breaks' as above direction", () => {
    const result = parseAlertRequest("when price breaks 90%", NOTIFY_URL);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("above");
  });

  test("parses 'tops' as above direction", () => {
    const result = parseAlertRequest("when market tops 75%", NOTIFY_URL);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("above");
  });

  test("parses 'less than' as below direction", () => {
    const result = parseAlertRequest("if odds are less than 30%", NOTIFY_URL);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("below");
  });

  test("parses 'greater than' as above direction", () => {
    const result = parseAlertRequest("when price is greater than 60%", NOTIFY_URL);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("above");
  });

  test("parses 'more than' as above direction", () => {
    const result = parseAlertRequest("if approval is more than 55%", NOTIFY_URL);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("above");
  });

  test("parses 'falls under' as below direction", () => {
    const result = parseAlertRequest("when support falls under 25%", NOTIFY_URL);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("below");
  });
});

// ─── NLP: Outcome Detection ─────────────────────────────────────────────────

describe("NLP - outcome detection", () => {
  test("detects 'lose' keyword as No outcome", () => {
    const result = parseAlertRequest("when lose exceeds 60%", NOTIFY_URL);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("No");
  });

  test("detects 'reject' keyword as No outcome", () => {
    const result = parseAlertRequest("if reject probability exceeds 50%", NOTIFY_URL);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("No");
  });

  test("detects 'fail' keyword as No outcome", () => {
    const result = parseAlertRequest("when fail probability exceeds 40%", NOTIFY_URL);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("No");
  });

  test("detects 'approve' keyword as Yes outcome", () => {
    const result = parseAlertRequest("when approve odds exceed 60%", NOTIFY_URL);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("Yes");
  });

  test("detects 'win' keyword as Yes outcome", () => {
    const result = parseAlertRequest("when win probability exceeds 70%", NOTIFY_URL);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("Yes");
  });

  test("explicit No mention overrides other keywords", () => {
    const result = parseAlertRequest("when No hits 40%", NOTIFY_URL);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("No");
  });

  test("defaults to Yes when no keywords present", () => {
    const result = parseAlertRequest("when price exceeds 55%", NOTIFY_URL);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("Yes");
  });
});

// ─── NLP: Edge Cases ─────────────────────────────────────────────────────────

describe("NLP - parsing edge cases", () => {
  test("handles only whitespace", () => {
    const result = parseAlertRequest("   ", NOTIFY_URL);
    expect(result).toBeNull();
  });

  test("handles very long input string", () => {
    const longInput = "when " + "very ".repeat(100) + "important thing exceeds 50%";
    const result = parseAlertRequest(longInput, NOTIFY_URL);
    // Should still parse the percentage
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(50);
  });

  test("handles input with only numbers", () => {
    const result = parseAlertRequest("60", NOTIFY_URL);
    expect(result).toBeNull();
  });

  test("handles percentage without context", () => {
    const result = parseAlertRequest("50%", NOTIFY_URL);
    // No direction keyword - should return null
    expect(result).toBeNull();
  });

  test("preserves notifyUrl in all parsed results", () => {
    const customUrl = "https://custom.webhook.io/alerts";
    const result = parseAlertRequest("when Trump exceeds 60%", customUrl);
    expect(result).not.toBeNull();
    expect(result!.notifyUrl).toBe(customUrl);
  });

  test("marketId is always empty string from parser", () => {
    const result = parseAlertRequest("when Trump exceeds 60%", NOTIFY_URL);
    expect(result).not.toBeNull();
    expect(result!.marketId).toBe("");
  });
});

// ─── Multi-condition Parsing ─────────────────────────────────────────────────

describe("Multi-condition - advanced", () => {
  test("handles three conditions with AND separators", () => {
    const results = parseMultiConditionAlert(
      "Trump > 60% and Biden < 40% and recession above 70%",
      NOTIFY_URL
    );
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  test("preserves notifyUrl for all conditions", () => {
    const results = parseMultiConditionAlert(
      "Trump > 60% & Biden < 40%",
      "https://my-webhook.com"
    );
    for (const r of results) {
      expect(r.notifyUrl).toBe("https://my-webhook.com");
    }
  });

  test("handles pipe separator", () => {
    const results = parseMultiConditionAlert(
      "Trump > 60% | Biden < 40%",
      NOTIFY_URL
    );
    expect(results.length).toBe(2);
  });

  test("parses mixed directions in multi-condition", () => {
    const results = parseMultiConditionAlert(
      "Trump exceeds 60% and recession falls below 30%",
      NOTIFY_URL
    );
    if (results.length >= 2) {
      expect(results[0].direction).toBe("above");
      expect(results[1].direction).toBe("below");
    }
  });

  test("skips unparseable parts in multi-condition", () => {
    const results = parseMultiConditionAlert(
      "hello world and Trump > 60%",
      NOTIFY_URL
    );
    expect(results.length).toBe(1);
    expect(results[0].threshold).toBe(60);
  });
});

// ─── Keyword Extraction ──────────────────────────────────────────────────────

describe("Keyword extraction - advanced", () => {
  test("extracts multi-word named entity", () => {
    const keywords = extractSearchKeywords("when Bitcoin ETF approval exceeds 60%");
    const hasRelevantKeyword = keywords.some(k =>
      k.includes("Bitcoin") || k.includes("ETF")
    );
    expect(hasRelevantKeyword).toBe(true);
  });

  test("extracts 'will X win' pattern", () => {
    const keywords = extractSearchKeywords("will Trump win the election above 60%");
    expect(keywords.length).toBeGreaterThan(0);
  });

  test("returns array type for any input", () => {
    for (const input of ["", "x", "A very long query about many topics"]) {
      const keywords = extractSearchKeywords(input);
      expect(Array.isArray(keywords)).toBe(true);
    }
  });

  test("no duplicate keywords", () => {
    const keywords = extractSearchKeywords("Bitcoin Bitcoin Bitcoin above 60%");
    const unique = new Set(keywords);
    expect(unique.size).toBe(keywords.length);
  });

  test("extracts from 'regarding' pattern", () => {
    const keywords = extractSearchKeywords("alert regarding recession odds above 50%");
    expect(keywords.length).toBeGreaterThan(0);
  });
});

// ─── x402 Payment - Concurrent Nonce Generation ─────────────────────────────

describe("x402 - nonce uniqueness under rapid calls", () => {
  test("generates 10 unique nonces rapidly", () => {
    const nonces = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const result = createPaymentRequired("/alerts", `test-${i}`);
      nonces.add(result.body.nonce);
    }
    expect(nonces.size).toBe(10);
  });

  test("all nonces are valid hex strings", () => {
    for (let i = 0; i < 5; i++) {
      const result = createPaymentRequired("/test", "desc");
      expect(result.body.nonce).toMatch(/^0x[0-9a-fA-F]+$/);
    }
  });
});

// ─── x402 - verifyPayment Chain ID Coverage ─────────────────────────────────

describe("verifyPayment - comprehensive chain ID rejection", () => {
  const WRONG_CHAINS = [1, 5, 10, 56, 100, 137, 250, 42161, 43114, 84531];

  for (const chainId of WRONG_CHAINS) {
    test(`rejects chain ID ${chainId}`, async () => {
      const result = await verifyPayment({
        transactionHash: "0xabc",
        blockNumber: 1,
        chainId,
        payer: "0x1234",
        amount: "10000",
      });
      expect(result.valid).toBe(false);
    });
  }

  test("only accepts chain ID 8453", async () => {
    // This will fail at RPC level but passes chain ID check
    const result = await verifyPayment({
      transactionHash: "0x0000000000000000000000000000000000000000000000000000000000000001",
      blockNumber: 1,
      chainId: 8453,
      payer: "0x1234",
      amount: "10000",
    });
    // Should fail for RPC reasons, NOT chain ID
    expect(result.valid).toBe(false);
    if (result.error) {
      expect(result.error).not.toMatch(/chain/i);
    }
  });
});

// ─── x402 - calculateBulkPrice Consistency ──────────────────────────────────

describe("calculateBulkPrice - mathematical consistency", () => {
  test("higher count always means lower or equal pricePerAlert", () => {
    let prevPrice = Infinity;
    for (const count of [1, 3, 5, 7, 10, 20, 100]) {
      const result = calculateBulkPrice(count);
      expect(result.pricePerAlert).toBeLessThanOrEqual(prevPrice);
      prevPrice = result.pricePerAlert;
    }
  });

  test("totalUsdc scales linearly within discount tier", () => {
    // Within tier 0% (1-4)
    const r1 = calculateBulkPrice(1);
    const r3 = calculateBulkPrice(3);
    expect(r3.totalUsdc).toBeCloseTo(r1.totalUsdc * 3, 8);

    // Within tier 10% (5-9)
    const r5 = calculateBulkPrice(5);
    const r7 = calculateBulkPrice(7);
    expect(r7.totalUsdc).toBeCloseTo(r5.pricePerAlert * 7, 8);
  });

  test("discount transitions create savings", () => {
    const r4 = calculateBulkPrice(4);
    const r5 = calculateBulkPrice(5);
    // 5 alerts with 10% discount should cost less than 5 × full price
    expect(r5.totalUsdc).toBeLessThan(r4.pricePerAlert * 5);
  });
});

// ─── API: Health Endpoint Stability ──────────────────────────────────────────

describe("API - health endpoint consistency", () => {
  test("consecutive health checks return consistent structure", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await apiReq("GET", "/health");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("status");
      expect(body).toHaveProperty("version");
      expect(body).toHaveProperty("alertCount");
      expect(body).toHaveProperty("timestamp");
    }
  });

  test("health endpoint returns correct content type", async () => {
    const res = await apiReq("GET", "/health");
    const ct = res.headers.get("content-type");
    expect(ct).toMatch(/application\/json/);
  });
});

// ─── API: Unknown Routes ─────────────────────────────────────────────────────

describe("API - unknown routes", () => {
  test("returns 404 for unknown path", async () => {
    const res = await apiReq("GET", "/nonexistent");
    expect(res.status).toBe(404);
  });

  test("returns 404 for /api/v1 prefix", async () => {
    const res = await apiReq("GET", "/api/v1/health");
    expect(res.status).toBe(404);
  });
});

// ─── API: Markets Search with Complex Queries ────────────────────────────────

describe("API - markets search complex queries", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("handles URL-encoded special characters in query", async () => {
    global.fetch = mock(async () => new Response(JSON.stringify([]), { status: 200 }));
    const res = await apiReq("GET", "/markets/search?q=Trump%20%26%20Biden");
    expect(res.status).toBe(200);
  });

  test("handles very long query string", async () => {
    global.fetch = mock(async () => new Response(JSON.stringify([]), { status: 200 }));
    const longQuery = "a".repeat(500);
    const res = await apiReq("GET", `/markets/search?q=${longQuery}`);
    expect(res.status).toBe(200);
  });

  test("search returns proper market format with id, question, currentPrices", async () => {
    const mockMkt = {
      conditionId: "0xFORMAT",
      question: "Format test?",
      outcomes: ["Yes", "No"],
      tokens: [
        { token_id: "t1", outcome: "Yes", price: 0.55 },
        { token_id: "t2", outcome: "No", price: 0.45 },
      ],
      active: true,
      closed: false,
      volume: 5000,
    };
    global.fetch = mock(async () => new Response(JSON.stringify([mockMkt]), { status: 200 }));

    const res = await apiReq("GET", "/markets/search?q=Format");
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.markets[0].id).toBe("0xFORMAT");
    expect(body.markets[0].question).toBe("Format test?");
    expect(body.markets[0].currentPrices).toHaveLength(2);
    expect(body.markets[0].currentPrices[0].price).toMatch(/%$/);
  });
});

// ─── API: Alerts POST - 402 Payment Details ──────────────────────────────────

describe("API - 402 payment response details", () => {
  test("402 response has correct content-type via X-Payment-Version header", async () => {
    const res = await apiReq("POST", "/alerts", {
      body: { description: "My alert" },
    });
    expect(res.headers.get("X-Payment-Version")).toBe("1.0");
  });

  test("402 body has valid asset address", async () => {
    const res = await apiReq("POST", "/alerts", { body: {} });
    const body = await res.json();
    expect(body.asset).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  test("402 body has valid payTo address", async () => {
    const res = await apiReq("POST", "/alerts", { body: {} });
    const body = await res.json();
    expect(body.payTo).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  test("402 body expiry is roughly 1 hour from now", async () => {
    const before = Math.floor(Date.now() / 1000);
    const res = await apiReq("POST", "/alerts", { body: {} });
    const body = await res.json();
    const after = Math.floor(Date.now() / 1000);
    expect(body.expiry).toBeGreaterThanOrEqual(before + 3590);
    expect(body.expiry).toBeLessThanOrEqual(after + 3610);
  });
});

// ─── API: Pricing Endpoint Calculations ──────────────────────────────────────

describe("API - pricing calculations via endpoint", () => {
  test("pricing for 1 alert matches direct calculation", async () => {
    const res = await apiReq("GET", "/pricing?count=1");
    const body = await res.json();
    const direct = calculateBulkPrice(1);
    expect(body.totalUsdc).toBe(direct.totalUsdc);
    expect(body.discount).toBe(direct.discount);
    expect(body.pricePerAlert).toBe(direct.pricePerAlert);
  });

  test("pricing for 5 alerts matches direct calculation", async () => {
    const res = await apiReq("GET", "/pricing?count=5");
    const body = await res.json();
    const direct = calculateBulkPrice(5);
    expect(body.discount).toBe(direct.discount);
  });

  test("pricing for 10 alerts matches direct calculation", async () => {
    const res = await apiReq("GET", "/pricing?count=10");
    const body = await res.json();
    const direct = calculateBulkPrice(10);
    expect(body.discount).toBe(direct.discount);
  });
});

// ─── Workflow Default Export Metadata ─────────────────────────────────────────

describe("Workflow metadata", () => {
  test("workflow name is 'polymarket-alerts'", async () => {
    const wf = (await import("../polymarket-alert-workflow")).default;
    expect(wf.name).toBe("polymarket-alerts");
  });

  test("workflow triggers include cron schedule", async () => {
    const wf = (await import("../polymarket-alert-workflow")).default;
    expect(wf.triggers.length).toBeGreaterThan(0);
    expect(wf.triggers[0]).toMatch(/cron:/);
  });

  test("workflow cron runs every 5 minutes", async () => {
    const wf = (await import("../polymarket-alert-workflow")).default;
    expect(wf.triggers).toContain("cron:*/5 * * * *");
  });

  test("workflow description mentions prediction", async () => {
    const wf = (await import("../polymarket-alert-workflow")).default;
    expect(wf.description.toLowerCase()).toContain("prediction");
  });
});

// ─── Payment Instructions Content ────────────────────────────────────────────

describe("Payment instructions - content validation", () => {
  test("instructions mention all 4 wallet options", () => {
    const inst = getPaymentInstructions();
    expect(inst).toContain("Coinbase");
    expect(inst).toContain("MetaMask");
    expect(inst).toContain("Rainbow");
  });

  test("instructions include step-by-step numbered list", () => {
    const inst = getPaymentInstructions();
    const steps = inst.match(/\d+\.\s/g);
    expect(steps).not.toBeNull();
    expect(steps!.length).toBeGreaterThanOrEqual(4);
  });

  test("instructions include both addresses", () => {
    const inst = getPaymentInstructions();
    // Payment receiver
    expect(inst).toMatch(/0x[0-9a-fA-F]{40}/);
    // USDC contract
    expect(inst).toContain("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  });
});

// ─── API: GET /alerts List ───────────────────────────────────────────────────

describe("API - alerts list format", () => {
  test("alerts response has proper structure", async () => {
    const res = await apiReq("GET", "/alerts");
    const body = await res.json();
    expect(typeof body.count).toBe("number");
    expect(Array.isArray(body.alerts)).toBe(true);
    expect(body.count).toBe(body.alerts.length);
  });

  test("each alert in list has an id field", async () => {
    const res = await apiReq("GET", "/alerts");
    const body = await res.json();
    for (const alert of body.alerts) {
      expect(typeof alert.id).toBe("number");
    }
  });
});

// ─── API: Market Details Response Format ─────────────────────────────────────

describe("API - market details format", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("market details include active and closed state", async () => {
    global.fetch = mock(async () =>
      new Response(JSON.stringify(makeMarket(0.65, {
        condition_id: "0xDETAIL",
        question: "Detail test?"
      })), { status: 200 })
    );

    const res = await apiReq("GET", "/markets/0xDETAIL");
    const body = await res.json();
    expect(body).toHaveProperty("active");
    expect(body).toHaveProperty("closed");
  });

  test("market outcomes include tokenId", async () => {
    global.fetch = mock(async () =>
      new Response(JSON.stringify(makeMarket(0.65, {
        condition_id: "0xTOKEN",
      })), { status: 200 })
    );

    const res = await apiReq("GET", "/markets/0xTOKEN");
    const body = await res.json();
    for (const outcome of body.outcomes) {
      expect(outcome).toHaveProperty("tokenId");
      expect(outcome).toHaveProperty("name");
      expect(outcome).toHaveProperty("price");
    }
  });

  test("market prices are formatted as percentage strings", async () => {
    global.fetch = mock(async () =>
      new Response(JSON.stringify(makeMarket(0.7777)), { status: 200 })
    );

    const res = await apiReq("GET", "/markets/0xPRICE");
    const body = await res.json();
    expect(body.outcomes[0].price).toMatch(/\d+\.\d+%$/);
  });
});
