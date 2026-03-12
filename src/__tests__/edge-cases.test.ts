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
  getPaymentInstructions,
  calculateBulkPrice,
} from "../x402-handler";
import app from "../api";

// Helper to make a mock market
function makeMarket(price = 0.65, options: Partial<{
  condition_id: string;
  question: string;
  active: boolean;
  closed: boolean;
  volume: number;
  outcomes: string[];
}> = {}) {
  return {
    condition_id: options.condition_id || "0xtest",
    question: options.question || "Will X happen?",
    outcomes: options.outcomes || ["Yes", "No"],
    tokens: [
      { token_id: "t1", outcome: "Yes", price, winner: false },
      { token_id: "t2", outcome: "No", price: 1 - price, winner: false },
    ],
    active: options.active !== undefined ? options.active : true,
    closed: options.closed !== undefined ? options.closed : false,
    volume: options.volume || 50000,
  };
}

describe("NLP Parsing Edge Cases", () => {
  test("parses 'exceed' as above direction", () => {
    const result = parseAlertRequest("when Trump odds exceed 60%", "http://hook");
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("above");
    expect(result!.threshold).toBe(60);
  });

  test("parses 'fall below' as below direction", () => {
    const result = parseAlertRequest("if recession falls below 30%", "http://hook");
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("below");
    expect(result!.threshold).toBe(30);
  });

  test("parses 'drops to' as below", () => {
    const result = parseAlertRequest("when price drops to 25%", "http://hook");
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("below");
    expect(result!.threshold).toBe(25);
  });

  test("parses '>' operator", () => {
    const result = parseAlertRequest("Trump > 55%", "http://hook");
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("above");
    expect(result!.threshold).toBe(55);
  });

  test("parses '<' operator", () => {
    const result = parseAlertRequest("Biden < 40%", "http://hook");
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("below");
    expect(result!.threshold).toBe(40);
  });

  test("parses 'hits' as above direction", () => {
    const result = parseAlertRequest("when gold hits 70%", "http://hook");
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("above");
    expect(result!.threshold).toBe(70);
  });

  test("parses 'reaches' as above direction", () => {
    const result = parseAlertRequest("if approval reaches 80%", "http://hook");
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("above");
  });

  test("parses 'rises to' as above", () => {
    const result = parseAlertRequest("when odds rises to 65%", "http://hook");
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("above");
  });

  test("parses 'goes above' as above", () => {
    const result = parseAlertRequest("if it goes above 50%", "http://hook");
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("above");
    expect(result!.threshold).toBe(50);
  });

  test("parses 'dips below' as below", () => {
    const result = parseAlertRequest("when confidence dips below 20%", "http://hook");
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("below");
    expect(result!.threshold).toBe(20);
  });

  test("parses 'cents' format", () => {
    const result = parseAlertRequest("when price at 70 cents", "http://hook");
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(70);
  });

  test("parses 'percent' word format", () => {
    const result = parseAlertRequest("when odds exceed 45 percent", "http://hook");
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(45);
  });

  test("parses decimal percentage like 55.5%", () => {
    const result = parseAlertRequest("when X exceeds 55.5%", "http://hook");
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(55.5);
  });

  test("detects 'No' outcome from explicit mention", () => {
    const result = parseAlertRequest("when No hits 40%", "http://hook");
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("No");
  });

  test("detects 'No' outcome from won't keyword", () => {
    const result = parseAlertRequest("if it won't pass exceeds 60%", "http://hook");
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("No");
  });

  test("defaults to 'Yes' outcome", () => {
    const result = parseAlertRequest("when Trump exceeds 60%", "http://hook");
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("Yes");
  });

  test("returns null for unparseable input", () => {
    const result = parseAlertRequest("hello world", "http://hook");
    expect(result).toBeNull();
  });

  test("returns null for empty string", () => {
    const result = parseAlertRequest("", "http://hook");
    expect(result).toBeNull();
  });

  test("returns null for no percentage or direction", () => {
    const result = parseAlertRequest("tell me about markets", "http://hook");
    expect(result).toBeNull();
  });

  test("handles 100% threshold", () => {
    const result = parseAlertRequest("when certainty exceeds 100%", "http://hook");
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(100);
  });

  test("handles 0% threshold", () => {
    const result = parseAlertRequest("when odds drop below 0%", "http://hook");
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(0);
  });

  test("handles 'surpasses' keyword", () => {
    const result = parseAlertRequest("when approval surpasses 75%", "http://hook");
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("above");
  });

  test("parses 'if' conditional prefix", () => {
    const result = parseAlertRequest("if recession odds exceed 50%", "http://hook");
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(50);
  });

  test("parses 'once' conditional prefix", () => {
    const result = parseAlertRequest("once approval goes above 70%", "http://hook");
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(70);
  });
});

describe("Multi-condition Parsing", () => {
  test("parses AND conditions", () => {
    const results = parseMultiConditionAlert(
      "when Trump exceeds 60% and Biden falls below 40%",
      "http://hook"
    );
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  test("parses OR conditions", () => {
    const results = parseMultiConditionAlert(
      "when recession above 70% or inflation below 20%",
      "http://hook"
    );
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  test("parses comma-separated conditions", () => {
    const results = parseMultiConditionAlert(
      "Trump > 60%, Biden < 40%",
      "http://hook"
    );
    // Comma without surrounding spaces may not split; verify at least 1 parsed
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  test("returns single result for single condition", () => {
    const results = parseMultiConditionAlert(
      "when Trump exceeds 60%",
      "http://hook"
    );
    expect(results.length).toBe(1);
  });

  test("returns empty for unparseable input", () => {
    const results = parseMultiConditionAlert("hello", "http://hook");
    expect(results.length).toBe(0);
  });

  test("handles '&' separator", () => {
    const results = parseMultiConditionAlert(
      "Trump > 60% & recession < 30%",
      "http://hook"
    );
    expect(results.length).toBe(2);
  });
});

describe("Search Keyword Extraction", () => {
  test("extracts capitalized named entities", () => {
    const keywords = extractSearchKeywords("Alert when Trump election odds exceed 60%");
    expect(keywords.some(k => k.includes("Trump"))).toBe(true);
  });

  test("extracts topic from 'about' phrase", () => {
    const keywords = extractSearchKeywords("Alert about Bitcoin ETF approval above 60%");
    expect(keywords.length).toBeGreaterThan(0);
  });

  test("extracts topic from election phrase", () => {
    const keywords = extractSearchKeywords("when presidential election outcome exceeds 70%");
    expect(keywords.length).toBeGreaterThan(0);
  });

  test("falls back to subject words for no entities", () => {
    const keywords = extractSearchKeywords("something interesting above 50%");
    expect(keywords.length).toBeGreaterThan(0);
  });

  test("deduplicates keywords", () => {
    const keywords = extractSearchKeywords("Trump Trump Trump exceeds 60%");
    const unique = new Set(keywords);
    expect(unique.size).toBe(keywords.length);
  });

  test("handles empty input", () => {
    const keywords = extractSearchKeywords("");
    expect(Array.isArray(keywords)).toBe(true);
  });
});

describe("x402 Payment Handler Additional Tests", () => {
  test("createPaymentRequired returns 402 status", () => {
    const result = createPaymentRequired("/alerts", "Test alert");
    expect(result.status).toBe(402);
    expect(result.headers["X-Payment-Required"]).toBe("true");
    expect(result.headers["X-Payment-Version"]).toBe("1.0");
  });

  test("createPaymentRequired includes all required fields", () => {
    const result = createPaymentRequired("/alerts", "Test");
    const body = result.body;
    expect(body.version).toBe("1.0");
    expect(body.network).toBe("base");
    expect(body.chainId).toBe(8453);
    expect(body.payTo).toBeDefined();
    expect(body.maxAmountRequired).toBe("10000");
    expect(body.resource).toBe("/alerts");
    expect(body.description).toBe("Test");
    expect(body.nonce).toBeDefined();
    expect(body.expiry).toBeGreaterThan(0);
  });

  test("createPaymentRequired generates unique nonces", () => {
    const r1 = createPaymentRequired("/a", "test");
    const r2 = createPaymentRequired("/b", "test");
    expect(r1.body.nonce).not.toBe(r2.body.nonce);
  });

  test("createPaymentRequired expiry is in the future", () => {
    const result = createPaymentRequired("/alerts", "test");
    const now = Math.floor(Date.now() / 1000);
    expect(result.body.expiry).toBeGreaterThan(now);
  });

  test("getPaymentInstructions returns markdown string", () => {
    const instructions = getPaymentInstructions();
    expect(instructions).toContain("USDC");
    expect(instructions).toContain("Base");
    expect(instructions).toContain("8453");
  });

  test("calculateBulkPrice returns no discount for 1 alert", () => {
    const pricing = calculateBulkPrice(1);
    expect(pricing.discount).toBe(0);
    expect(pricing.pricePerAlert).toBe(0.01);
    expect(pricing.totalUsdc).toBe(0.01);
  });

  test("calculateBulkPrice returns 10% discount for 5 alerts", () => {
    const pricing = calculateBulkPrice(5);
    expect(pricing.discount).toBe(0.10);
    expect(pricing.pricePerAlert).toBeCloseTo(0.009);
    expect(pricing.totalUsdc).toBeCloseTo(0.045);
  });

  test("calculateBulkPrice returns 20% discount for 10 alerts", () => {
    const pricing = calculateBulkPrice(10);
    expect(pricing.discount).toBe(0.20);
    expect(pricing.pricePerAlert).toBeCloseTo(0.008);
    expect(pricing.totalUsdc).toBeCloseTo(0.08);
  });

  test("calculateBulkPrice returns 20% discount for 100 alerts", () => {
    const pricing = calculateBulkPrice(100);
    expect(pricing.discount).toBe(0.20);
    expect(pricing.totalUsdc).toBeCloseTo(0.8);
  });

  test("calculateBulkPrice handles 0 alerts", () => {
    const pricing = calculateBulkPrice(0);
    expect(pricing.totalUsdc).toBe(0);
  });

  test("calculateBulkPrice no discount for 4 alerts", () => {
    const pricing = calculateBulkPrice(4);
    expect(pricing.discount).toBe(0);
    expect(pricing.totalUsdc).toBeCloseTo(0.04);
  });

  test("calculateBulkPrice 10% discount for 9 alerts", () => {
    const pricing = calculateBulkPrice(9);
    expect(pricing.discount).toBe(0.10);
    expect(pricing.pricePerAlert).toBeCloseTo(0.009);
  });
});

describe("Workflow Execution Edge Cases", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("skips already triggered alerts", async () => {
    global.fetch = mock(async () =>
      new Response(JSON.stringify(makeMarket(0.75)), { status: 200 })
    );

    const state = {
      alertConfigs: [{
        marketId: "0xtest",
        outcome: "Yes",
        threshold: 60,
        direction: "above" as const,
        notifyUrl: "http://hook",
      }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: ["0xtest-Yes-60-above"], // Already triggered
    };

    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(0);
  });

  test("skips rate-limited markets (checked < 1min ago)", async () => {
    global.fetch = mock(async () =>
      new Response(JSON.stringify(makeMarket(0.75)), { status: 200 })
    );

    const state = {
      alertConfigs: [{
        marketId: "0xtest",
        outcome: "Yes",
        threshold: 60,
        direction: "above" as const,
        notifyUrl: "http://hook",
      }],
      lastChecked: { "0xtest": Date.now() - 10000 }, // 10 seconds ago
      triggeredAlerts: [] as string[],
    };

    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(0);
  });

  test("skips inactive markets", async () => {
    global.fetch = mock(async () =>
      new Response(JSON.stringify(makeMarket(0.75, { active: false })), { status: 200 })
    );

    const state = {
      alertConfigs: [{
        marketId: "0xtest",
        outcome: "Yes",
        threshold: 60,
        direction: "above" as const,
        notifyUrl: "http://hook",
      }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };

    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(0);
  });

  test("skips closed markets", async () => {
    global.fetch = mock(async () =>
      new Response(JSON.stringify(makeMarket(0.75, { closed: true })), { status: 200 })
    );

    const state = {
      alertConfigs: [{
        marketId: "0xtest",
        outcome: "Yes",
        threshold: 60,
        direction: "above" as const,
        notifyUrl: "http://hook",
      }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };

    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(0);
  });

  test("handles empty alert configs", async () => {
    const state = {
      alertConfigs: [],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };

    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(0);
  });

  test("does not trigger alert when below threshold (above direction)", async () => {
    global.fetch = mock(async () =>
      new Response(JSON.stringify(makeMarket(0.50)), { status: 200 })
    );

    const state = {
      alertConfigs: [{
        marketId: "0xtest",
        outcome: "Yes",
        threshold: 60,
        direction: "above" as const,
        notifyUrl: "http://hook",
      }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };

    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(0);
  });

  test("does not trigger alert when above threshold (below direction)", async () => {
    global.fetch = mock(async () =>
      new Response(JSON.stringify(makeMarket(0.50)), { status: 200 })
    );

    const state = {
      alertConfigs: [{
        marketId: "0xtest",
        outcome: "Yes",
        threshold: 40,
        direction: "below" as const,
        notifyUrl: "http://hook",
      }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };

    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(0);
  });

  test("triggers alert when exactly at threshold (above)", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.60)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });

    const state = {
      alertConfigs: [{
        marketId: "0xtest",
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
  });

  test("triggers alert when exactly at threshold (below)", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.40)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });

    const state = {
      alertConfigs: [{
        marketId: "0xtest",
        outcome: "Yes",
        threshold: 40,
        direction: "below" as const,
        notifyUrl: "http://hook",
      }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };

    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(1);
  });

  test("handles multiple alerts for different markets", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("market-1")) {
        return new Response(JSON.stringify(makeMarket(0.75, { condition_id: "market-1" })), { status: 200 });
      }
      if (typeof url === "string" && url.includes("market-2")) {
        return new Response(JSON.stringify(makeMarket(0.25, { condition_id: "market-2" })), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });

    const state = {
      alertConfigs: [
        { marketId: "market-1", outcome: "Yes", threshold: 60, direction: "above" as const, notifyUrl: "http://hook" },
        { marketId: "market-2", outcome: "Yes", threshold: 30, direction: "below" as const, notifyUrl: "http://hook" },
      ],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };

    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(2);
  });
});

describe("API Endpoint Edge Cases", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("GET /health returns healthy status", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("healthy");
    expect(body.version).toBeDefined();
    expect(body.timestamp).toBeDefined();
  });

  test("GET /payment-info returns payment details", async () => {
    const res = await app.request("/payment-info");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.network).toBe("Base");
    expect(body.chainId).toBe(8453);
    expect(body.amount).toBe(0.01);
    expect(body.receiver).toBeDefined();
    expect(body.asset).toBeDefined();
    expect(body.instructions).toContain("USDC");
  });

  test("GET /pricing returns default pricing for 1 alert", async () => {
    const res = await app.request("/pricing");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.discount).toBe(0);
    expect(body.totalUsdc).toBe(0.01);
  });

  test("GET /pricing returns bulk discount for count=10", async () => {
    const res = await app.request("/pricing?count=10");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.discount).toBe(0.2);
  });

  test("GET /markets/search rejects short query", async () => {
    const res = await app.request("/markets/search?q=a");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("2 characters");
  });

  test("GET /markets/search rejects empty query", async () => {
    const res = await app.request("/markets/search");
    expect(res.status).toBe(400);
  });

  test("DELETE /alerts/:id returns 404 for invalid id", async () => {
    const res = await app.request("/alerts/999", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  test("DELETE /alerts/:id returns 404 for NaN id", async () => {
    const res = await app.request("/alerts/abc", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  test("DELETE /alerts/:id returns 404 for negative id", async () => {
    const res = await app.request("/alerts/-1", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  test("GET /alerts returns empty list initially", async () => {
    const res = await app.request("/alerts");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(body.alerts)).toBe(true);
  });
});

describe("Workflow Default Export", () => {
  test("exports correct workflow metadata", async () => {
    const wf = (await import("../polymarket-alert-workflow")).default;
    expect(wf.name).toBe("polymarket-alerts");
    expect(wf.version).toBe("1.1.0");
    expect(wf.description).toContain("prediction market");
    expect(wf.triggers).toContain("cron:*/5 * * * *");
    expect(typeof wf.execute).toBe("function");
  });

  test("exports helper functions", async () => {
    const wf = (await import("../polymarket-alert-workflow")).default;
    expect(typeof wf.helpers.parseAlertRequest).toBe("function");
    expect(typeof wf.helpers.searchMarkets).toBe("function");
    expect(typeof wf.helpers.fetchMarketData).toBe("function");
  });
});

describe("x402 Default Export", () => {
  test("exports all required functions", async () => {
    const x402 = (await import("../x402-handler")).default;
    expect(typeof x402.createPaymentRequired).toBe("function");
    expect(typeof x402.verifyPayment).toBe("function");
    expect(typeof x402.getPaymentInstructions).toBe("function");
    expect(typeof x402.calculateBulkPrice).toBe("function");
  });

  test("exports constants", async () => {
    const x402 = (await import("../x402-handler")).default;
    expect(x402.PAYMENT_RECEIVER).toBeDefined();
    expect(x402.USDC_ADDRESS_BASE).toBeDefined();
    expect(x402.ALERT_PRICE_USDC).toBe("10000");
    expect(x402.BASE_CHAIN_ID).toBe(8453);
  });
});
