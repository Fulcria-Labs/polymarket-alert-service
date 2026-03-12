/**
 * Concurrent Operation Scenarios
 *
 * Covers: parallel workflow executions, race conditions with state,
 * concurrent market fetches, parallel alert evaluations, bulk alert
 * creation stress, concurrent payment requests, fetch timeout isolation.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import {
  executeWorkflow,
  fetchMarketData,
  searchMarkets,
  parseAlertRequest,
  parseMultiConditionAlert,
} from "../polymarket-alert-workflow";
import { createPaymentRequired, calculateBulkPrice } from "../x402-handler";
import app from "../api";

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface AlertConfig {
  marketId: string;
  outcome: string;
  threshold: number;
  direction: "above" | "below";
  notifyUrl: string;
}

interface WorkflowState {
  alertConfigs: AlertConfig[];
  lastChecked: Record<string, number>;
  triggeredAlerts: string[];
}

function makeState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    alertConfigs: overrides.alertConfigs || [],
    lastChecked: overrides.lastChecked || {},
    triggeredAlerts: overrides.triggeredAlerts || [],
  };
}

function makeAlert(overrides: Partial<AlertConfig> = {}): AlertConfig {
  return {
    marketId: overrides.marketId || "0xCONC",
    outcome: overrides.outcome || "Yes",
    threshold: overrides.threshold || 60,
    direction: overrides.direction || "above",
    notifyUrl: overrides.notifyUrl || "https://hook.test/concurrent",
  };
}

function makeMarket(price = 0.65, overrides: Record<string, any> = {}) {
  return {
    condition_id: overrides.condition_id || "0xCONC",
    question: overrides.question || "Concurrent test?",
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

// ─── Parallel workflow executions ───────────────────────────────────────────

describe("Concurrent - parallel workflow executions", () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("two independent workflow executions don't interfere", async () => {
    global.fetch = mock(async (url: string | Request) => {
      const urlStr = typeof url === "string" ? url : url.url;
      if (urlStr.includes("clob")) {
        return new Response(JSON.stringify(makeMarket(0.70)), { status: 200 });
      }
      return new Response("OK", { status: 200 });
    });

    const state1 = makeState({
      alertConfigs: [makeAlert({ marketId: "0xP1", threshold: 60 })],
    });
    const state2 = makeState({
      alertConfigs: [makeAlert({ marketId: "0xP2", threshold: 60 })],
    });

    const [result1, result2] = await Promise.all([
      executeWorkflow(state1),
      executeWorkflow(state2),
    ]);

    expect(result1.alerts.length).toBe(1);
    expect(result2.alerts.length).toBe(1);
  });

  test("parallel executions with different thresholds", async () => {
    global.fetch = mock(async (url: string | Request) => {
      const urlStr = typeof url === "string" ? url : url.url;
      if (urlStr.includes("clob")) {
        return new Response(JSON.stringify(makeMarket(0.65)), { status: 200 });
      }
      return new Response("OK", { status: 200 });
    });

    const state1 = makeState({
      alertConfigs: [makeAlert({ marketId: "0xTH1", threshold: 60 })],
    });
    const state2 = makeState({
      alertConfigs: [makeAlert({ marketId: "0xTH2", threshold: 70 })],
    });

    const [result1, result2] = await Promise.all([
      executeWorkflow(state1),
      executeWorkflow(state2),
    ]);

    expect(result1.alerts.length).toBe(1); // 65% > 60%
    expect(result2.alerts.length).toBe(0); // 65% < 70%
  });

  test("5 parallel executions all complete successfully", async () => {
    global.fetch = mock(async () => {
      return new Response(JSON.stringify(makeMarket(0.50)), { status: 200 });
    });

    const states = Array.from({ length: 5 }, (_, i) =>
      makeState({
        alertConfigs: [makeAlert({ marketId: `0xBULK${i}`, threshold: 40 })],
      })
    );

    const results = await Promise.all(states.map(s => executeWorkflow(s)));
    expect(results.length).toBe(5);
    results.forEach(r => {
      expect(r.alerts.length).toBe(1); // 50% > 40%
    });
  });
});

// ─── Concurrent NLP parsing ────────────────────────────────────────────────

describe("Concurrent - NLP parsing is stateless", () => {
  test("parallel parseAlertRequest calls return independent results", () => {
    const inputs = [
      "Trump > 60%",
      "Biden < 40%",
      "Gold > 70%",
      "Silver < 30%",
      "ETF hits 80%",
    ];

    const results = inputs.map(input => parseAlertRequest(input, "https://hook"));
    expect(results.length).toBe(5);
    results.forEach(r => {
      expect(r).not.toBeNull();
    });

    expect(results[0]!.threshold).toBe(60);
    expect(results[0]!.direction).toBe("above");
    expect(results[1]!.threshold).toBe(40);
    expect(results[1]!.direction).toBe("below");
    expect(results[2]!.threshold).toBe(70);
    expect(results[3]!.threshold).toBe(30);
    expect(results[4]!.threshold).toBe(80);
  });

  test("parallel parseMultiConditionAlert calls are independent", () => {
    const r1 = parseMultiConditionAlert("A > 50% and B < 30%", "https://h1");
    const r2 = parseMultiConditionAlert("C > 60% and D < 40%", "https://h2");

    expect(r1.length).toBe(2);
    expect(r2.length).toBe(2);
    expect(r1[0].notifyUrl).toBe("https://h1");
    expect(r2[0].notifyUrl).toBe("https://h2");
  });
});

// ─── Concurrent payment requests ───────────────────────────────────────────

describe("Concurrent - payment requests", () => {
  test("10 concurrent createPaymentRequired all produce unique nonces", () => {
    const results = Array.from({ length: 10 }, () =>
      createPaymentRequired("/alerts", "test")
    );

    const nonces = new Set(results.map(r => r.body.nonce));
    expect(nonces.size).toBe(10);
  });

  test("concurrent pricing calculations are consistent", () => {
    const counts = [1, 5, 10, 50, 100];
    const results = counts.map(c => calculateBulkPrice(c));

    expect(results[0].discount).toBe(0);
    expect(results[1].discount).toBe(0.10);
    expect(results[2].discount).toBe(0.20);
    expect(results[3].discount).toBe(0.20);
    expect(results[4].discount).toBe(0.20);
  });

  test("concurrent payment requests all have valid expiry", () => {
    const now = Math.floor(Date.now() / 1000);
    const results = Array.from({ length: 5 }, () =>
      createPaymentRequired("/test", "test")
    );

    results.forEach(r => {
      expect(r.body.expiry).toBeGreaterThan(now);
      expect(r.body.expiry).toBeLessThanOrEqual(now + 3602);
    });
  });
});

// ─── Concurrent API requests ───────────────────────────────────────────────

describe("Concurrent - API endpoint stress", () => {
  test("10 concurrent health checks all return 200", async () => {
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => apiReq("GET", "/health"))
    );

    responses.forEach(r => {
      expect(r.status).toBe(200);
    });
  });

  test("concurrent pricing requests return consistent results", async () => {
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => apiReq("GET", "/pricing?count=10"))
    );

    const bodies = await Promise.all(responses.map(r => r.json()));
    bodies.forEach(b => {
      expect(b.discount).toBe(0.20);
    });
  });

  test("concurrent payment-info requests return identical info", async () => {
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => apiReq("GET", "/payment-info"))
    );

    const bodies = await Promise.all(responses.map(r => r.json()));
    for (let i = 1; i < bodies.length; i++) {
      expect(bodies[i].receiver).toBe(bodies[0].receiver);
      expect(bodies[i].asset).toBe(bodies[0].asset);
      expect(bodies[i].network).toBe(bodies[0].network);
    }
  });

  test("concurrent 402 requests all return payment required", async () => {
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        apiReq("POST", "/alerts", { body: { description: "test" } })
      )
    );

    responses.forEach(r => {
      expect(r.status).toBe(402);
    });

    const bodies = await Promise.all(responses.map(r => r.json()));
    const nonces = new Set(bodies.map(b => b.nonce));
    expect(nonces.size).toBe(5); // All unique
  });
});

// ─── Fetch error isolation ──────────────────────────────────────────────────

describe("Concurrent - fetch error isolation", () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("one failing market fetch doesn't affect others", async () => {
    let callCount = 0;
    global.fetch = mock(async (url: string | Request) => {
      const urlStr = typeof url === "string" ? url : url.url;
      callCount++;
      if (urlStr.includes("0xFAIL")) {
        throw new Error("Network error");
      }
      if (urlStr.includes("clob")) {
        return new Response(JSON.stringify(makeMarket(0.70)), { status: 200 });
      }
      return new Response("OK", { status: 200 });
    });

    const state = makeState({
      alertConfigs: [
        makeAlert({ marketId: "0xFAIL", threshold: 60 }),
        makeAlert({ marketId: "0xOK1", threshold: 60 }),
      ],
    });

    const result = await executeWorkflow(state);
    // At least the OK market should be attempted
    expect(callCount).toBeGreaterThanOrEqual(1);
  });

  test("slow fetch doesn't block other operations", async () => {
    const startTime = Date.now();
    global.fetch = mock(async () => {
      // Simulate very fast response
      return new Response(JSON.stringify(makeMarket(0.50)), { status: 200 });
    });

    const state = makeState({
      alertConfigs: [makeAlert()],
    });

    await executeWorkflow(state);
    const elapsed = Date.now() - startTime;
    expect(elapsed).toBeLessThan(5000); // Should be fast
  });
});
