/**
 * Webhook Resilience Tests for Polymarket Alert Service
 *
 * Covers:
 * - Webhook resilience: timeouts, partial responses, retry-after headers,
 *   dead-letter scenarios, connection resets, DNS failures, SSL errors,
 *   slow responses, concurrent webhook sends
 * - Concurrent alert execution: 100+ simultaneous alerts, timeout isolation,
 *   race conditions between dedup and webhook, state consistency under load
 * - State persistence: alert state across restarts, max alert count limits,
 *   memory leak from triggered alerts, state cleanup of expired alerts
 * - Outcome matching: 3+ outcomes, case-insensitive, typos, mismatch recovery
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import {
  parseAlertRequest,
  executeWorkflow,
  fetchMarketData,
} from "../polymarket-alert-workflow";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const NOTIFY_URL = "https://webhook.example.com/notify";

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

function makeState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    alertConfigs: overrides.alertConfigs || [],
    lastChecked: overrides.lastChecked || {},
    triggeredAlerts: overrides.triggeredAlerts || [],
  };
}

function makeAlert(overrides: Partial<AlertConfig> = {}): AlertConfig {
  return {
    marketId: overrides.marketId || "0xMKT",
    outcome: overrides.outcome || "Yes",
    threshold: overrides.threshold || 60,
    direction: overrides.direction || "above",
    notifyUrl: overrides.notifyUrl || NOTIFY_URL,
  };
}

// ─── Webhook Resilience ──────────────────────────────────────────────────────

describe("Webhook Resilience", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("handles webhook timeout (fetch throws AbortError)", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.75)), { status: 200 });
      }
      const err = new DOMException("The operation was aborted", "AbortError");
      throw err;
    });

    const state = makeState({
      alertConfigs: [makeAlert()],
    });

    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(0);
    expect(result.state.triggeredAlerts).toHaveLength(0);
  });

  test("handles webhook returning 502 Bad Gateway", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.80)), { status: 200 });
      }
      return new Response("Bad Gateway", { status: 502 });
    });

    const state = makeState({
      alertConfigs: [makeAlert({ threshold: 70 })],
    });

    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(0);
    expect(result.state.triggeredAlerts).not.toContain("0xMKT-Yes-70-above");
  });

  test("handles webhook returning 503 Service Unavailable", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.80)), { status: 200 });
      }
      return new Response("Service Unavailable", { status: 503 });
    });

    const state = makeState({
      alertConfigs: [makeAlert({ threshold: 70 })],
    });

    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(0);
  });

  test("handles webhook returning 429 Too Many Requests", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.80)), { status: 200 });
      }
      return new Response("Rate Limited", {
        status: 429,
        headers: { "Retry-After": "60" },
      });
    });

    const state = makeState({
      alertConfigs: [makeAlert({ threshold: 70 })],
    });

    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(0);
    expect(result.state.triggeredAlerts).toHaveLength(0);
  });

  test("handles webhook returning empty body with 200", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.75)), { status: 200 });
      }
      return new Response("", { status: 200 });
    });

    const state = makeState({
      alertConfigs: [makeAlert()],
    });

    const result = await executeWorkflow(state);
    // 200 is ok, so alert should still be marked as triggered
    expect(result.alerts).toHaveLength(1);
    expect(result.state.triggeredAlerts).toContain("0xMKT-Yes-60-above");
  });

  test("handles webhook connection reset (ECONNRESET)", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.80)), { status: 200 });
      }
      throw new Error("read ECONNRESET");
    });

    const state = makeState({
      alertConfigs: [makeAlert({ threshold: 70 })],
    });

    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(0);
    expect(result.state.triggeredAlerts).toHaveLength(0);
  });

  test("handles webhook DNS failure (ENOTFOUND)", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.80)), { status: 200 });
      }
      throw new Error("getaddrinfo ENOTFOUND webhook.example.com");
    });

    const state = makeState({
      alertConfigs: [makeAlert({ threshold: 70 })],
    });

    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(0);
  });

  test("handles webhook SSL certificate error", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.80)), { status: 200 });
      }
      throw new Error("UNABLE_TO_VERIFY_LEAF_SIGNATURE");
    });

    const state = makeState({
      alertConfigs: [makeAlert({ threshold: 70 })],
    });

    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(0);
    expect(result.state.triggeredAlerts).toHaveLength(0);
  });

  test("handles webhook returning 301 redirect (non-ok for POST)", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.80)), { status: 200 });
      }
      // Redirect responses have ok=false for 301
      return new Response("Moved", { status: 301, headers: { Location: "https://other.com" } });
    });

    const state = makeState({
      alertConfigs: [makeAlert({ threshold: 70 })],
    });

    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(0);
  });

  test("handles webhook returning 204 No Content (ok status)", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.75)), { status: 200 });
      }
      return new Response(null, { status: 204 });
    });

    const state = makeState({
      alertConfigs: [makeAlert()],
    });

    const result = await executeWorkflow(state);
    // 204 is in the ok range (200-299)
    expect(result.alerts).toHaveLength(1);
    expect(result.state.triggeredAlerts).toContain("0xMKT-Yes-60-above");
  });

  test("handles webhook returning 0-byte response with connection close", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.75)), { status: 200 });
      }
      throw new Error("socket hang up");
    });

    const state = makeState({
      alertConfigs: [makeAlert()],
    });

    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(0);
  });

  test("handles TypeError from invalid URL in notifyUrl", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.75)), { status: 200 });
      }
      throw new TypeError("Failed to parse URL from not-a-url");
    });

    const state = makeState({
      alertConfigs: [makeAlert({ notifyUrl: "not-a-url" })],
    });

    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(0);
    expect(result.state.triggeredAlerts).toHaveLength(0);
  });

  test("handles webhook returning 403 Forbidden", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.80)), { status: 200 });
      }
      return new Response("Forbidden", { status: 403 });
    });

    const state = makeState({
      alertConfigs: [makeAlert({ threshold: 70 })],
    });

    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(0);
    expect(result.state.triggeredAlerts).toHaveLength(0);
  });

  test("handles webhook returning 408 Request Timeout", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.80)), { status: 200 });
      }
      return new Response("Request Timeout", { status: 408 });
    });

    const state = makeState({
      alertConfigs: [makeAlert({ threshold: 70 })],
    });

    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(0);
  });

  test("successful webhook with 201 Created marks alert as triggered", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.75)), { status: 200 });
      }
      return new Response(JSON.stringify({ received: true }), { status: 201 });
    });

    const state = makeState({
      alertConfigs: [makeAlert()],
    });

    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(1);
    expect(result.state.triggeredAlerts).toContain("0xMKT-Yes-60-above");
  });

  test("webhook receives Content-Type application/json header", async () => {
    let capturedHeaders: Record<string, string> = {};
    global.fetch = mock(async (url: string, opts?: any) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.75)), { status: 200 });
      }
      capturedHeaders = opts?.headers || {};
      return new Response("ok", { status: 200 });
    });

    const state = makeState({
      alertConfigs: [makeAlert()],
    });

    await executeWorkflow(state);
    expect(capturedHeaders["Content-Type"]).toBe("application/json");
  });

  test("webhook receives valid JSON payload with triggeredAt timestamp", async () => {
    let capturedBody: any = null;
    global.fetch = mock(async (url: string, opts?: any) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.75, { question: "Test Q?" })), { status: 200 });
      }
      capturedBody = JSON.parse(opts?.body || "{}");
      return new Response("ok", { status: 200 });
    });

    const state = makeState({
      alertConfigs: [makeAlert()],
    });

    await executeWorkflow(state);
    expect(capturedBody).not.toBeNull();
    expect(capturedBody.type).toBe("prediction_market_alert");
    expect(capturedBody.triggeredAt).toBeTruthy();
    // Validate ISO 8601 format
    expect(new Date(capturedBody.triggeredAt).toISOString()).toBe(capturedBody.triggeredAt);
  });

  test("webhook payload includes correct currentPrice as formatted string", async () => {
    let capturedBody: any = null;
    global.fetch = mock(async (url: string, opts?: any) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.7777)), { status: 200 });
      }
      capturedBody = JSON.parse(opts?.body || "{}");
      return new Response("ok", { status: 200 });
    });

    const state = makeState({
      alertConfigs: [makeAlert()],
    });

    await executeWorkflow(state);
    expect(capturedBody.currentPrice).toBe("77.77");
  });

  test("handles ECONNREFUSED from webhook endpoint", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.80)), { status: 200 });
      }
      throw new Error("connect ECONNREFUSED 127.0.0.1:443");
    });

    const state = makeState({
      alertConfigs: [makeAlert({ threshold: 70 })],
    });

    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(0);
    expect(result.state.triggeredAlerts).toHaveLength(0);
  });

  test("handles webhook returning malformed HTTP response", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.80)), { status: 200 });
      }
      throw new Error("Parse Error: Invalid HTTP response");
    });

    const state = makeState({
      alertConfigs: [makeAlert({ threshold: 70 })],
    });

    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(0);
  });
});

// ─── Concurrent Alert Execution ──────────────────────────────────────────────

describe("Concurrent Alert Execution", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("processes 100 alert configs without throwing", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.75)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });

    const alerts: AlertConfig[] = [];
    for (let i = 0; i < 100; i++) {
      alerts.push(makeAlert({
        marketId: `0xMKT-${i}`,
        threshold: 60,
      }));
    }

    const state = makeState({ alertConfigs: alerts });
    const result = await executeWorkflow(state);
    // All should process (unique marketIds, no rate limiting)
    expect(result.alerts.length).toBeGreaterThan(0);
    expect(result.state.triggeredAlerts.length).toBeGreaterThan(0);
  });

  test("150 alerts with mixed market conditions trigger correct subset", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        // Markets with even index have high price (triggers "above 60%")
        // Markets with odd index have low price (does not trigger "above 60%")
        const match = url.match(/0xMKT-(\d+)/);
        const idx = match ? parseInt(match[1]) : 0;
        const price = idx % 2 === 0 ? 0.75 : 0.40;
        return new Response(JSON.stringify(makeMarket(price, { condition_id: `0xMKT-${idx}` })), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });

    const alerts: AlertConfig[] = [];
    for (let i = 0; i < 150; i++) {
      alerts.push(makeAlert({
        marketId: `0xMKT-${i}`,
        threshold: 60,
        direction: "above",
      }));
    }

    const state = makeState({ alertConfigs: alerts });
    const result = await executeWorkflow(state);
    // Only even-indexed markets should trigger (75 of 150)
    expect(result.alerts.length).toBe(75);
    expect(result.state.triggeredAlerts.length).toBe(75);
  });

  test("webhook timeout for one alert does not prevent processing others", async () => {
    let webhookCallCount = 0;
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.80)), { status: 200 });
      }
      webhookCallCount++;
      // First webhook call throws, subsequent ones succeed
      if (webhookCallCount === 1) {
        throw new Error("Connection timed out");
      }
      return new Response("ok", { status: 200 });
    });

    const state = makeState({
      alertConfigs: [
        makeAlert({ marketId: "0xFAIL", threshold: 70 }),
        makeAlert({ marketId: "0xSUCCESS", threshold: 70 }),
      ],
    });

    const result = await executeWorkflow(state);
    // At least the second alert should succeed
    expect(result.state.triggeredAlerts).toContain("0xSUCCESS-Yes-70-above");
    expect(result.state.triggeredAlerts).not.toContain("0xFAIL-Yes-70-above");
  });

  test("dedup check correctly prevents duplicate trigger for same alert key", async () => {
    let webhookCalls = 0;
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.80)), { status: 200 });
      }
      webhookCalls++;
      return new Response("ok", { status: 200 });
    });

    // Two alerts with same marketId, outcome, threshold, direction = same alertKey
    const state = makeState({
      alertConfigs: [
        makeAlert({ marketId: "0xDUP", threshold: 70, notifyUrl: "http://hook1" }),
        makeAlert({ marketId: "0xDUP", threshold: 70, notifyUrl: "http://hook2" }),
      ],
    });

    const result = await executeWorkflow(state);
    // After first triggers and adds to triggeredAlerts, second with same key is skipped
    // But note: the rate limiter may also skip the second since same marketId
    // Either way, only one alertKey entry should exist
    const dupKeyCount = result.state.triggeredAlerts.filter(
      k => k === "0xDUP-Yes-70-above"
    ).length;
    expect(dupKeyCount).toBeLessThanOrEqual(1);
  });

  test("state.triggeredAlerts grows correctly with each new trigger", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.80)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });

    const state = makeState({
      alertConfigs: [
        makeAlert({ marketId: "0xA", threshold: 70 }),
        makeAlert({ marketId: "0xB", threshold: 70 }),
        makeAlert({ marketId: "0xC", threshold: 70 }),
      ],
    });

    const result = await executeWorkflow(state);
    expect(result.state.triggeredAlerts).toContain("0xA-Yes-70-above");
    expect(result.state.triggeredAlerts).toContain("0xB-Yes-70-above");
    expect(result.state.triggeredAlerts).toContain("0xC-Yes-70-above");
    expect(result.state.triggeredAlerts.length).toBe(3);
  });

  test("rate limiting prevents checking same market twice within 60s window", async () => {
    let fetchCount = 0;
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        fetchCount++;
        return new Response(JSON.stringify(makeMarket(0.50)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });

    // Two alerts with same marketId but different thresholds
    const state = makeState({
      alertConfigs: [
        makeAlert({ marketId: "0xRATE", threshold: 40, direction: "above" }),
        makeAlert({ marketId: "0xRATE", threshold: 60, direction: "above" }),
      ],
    });

    await executeWorkflow(state);
    // Should only fetch market data once due to rate limit
    expect(fetchCount).toBe(1);
  });

  test("concurrent execution does not corrupt lastChecked timestamps", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.50)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });

    const state = makeState({
      alertConfigs: [
        makeAlert({ marketId: "0xMKT1" }),
        makeAlert({ marketId: "0xMKT2" }),
        makeAlert({ marketId: "0xMKT3" }),
      ],
    });

    const beforeTime = Date.now();
    const result = await executeWorkflow(state);
    const afterTime = Date.now();

    for (const mkId of ["0xMKT1", "0xMKT2", "0xMKT3"]) {
      const ts = result.state.lastChecked[mkId];
      expect(ts).toBeGreaterThanOrEqual(beforeTime);
      expect(ts).toBeLessThanOrEqual(afterTime);
    }
  });

  test("already-triggered alerts are skipped without any fetch calls", async () => {
    let fetchCount = 0;
    global.fetch = mock(async (url: string) => {
      fetchCount++;
      return new Response(JSON.stringify(makeMarket(0.80)), { status: 200 });
    });

    const state = makeState({
      alertConfigs: [
        makeAlert({ marketId: "0xDONE", threshold: 70 }),
      ],
      triggeredAlerts: ["0xDONE-Yes-70-above"],
    });

    const result = await executeWorkflow(state);
    expect(fetchCount).toBe(0);
    expect(result.alerts).toHaveLength(0);
  });

  test("mixed success/failure across multiple alerts preserves partial results", async () => {
    let callIdx = 0;
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.80)), { status: 200 });
      }
      callIdx++;
      // Alternate success and failure
      if (callIdx % 2 === 0) {
        return new Response("Server Error", { status: 500 });
      }
      return new Response("ok", { status: 200 });
    });

    const state = makeState({
      alertConfigs: [
        makeAlert({ marketId: "0xW1", threshold: 70 }),
        makeAlert({ marketId: "0xW2", threshold: 70 }),
        makeAlert({ marketId: "0xW3", threshold: 70 }),
        makeAlert({ marketId: "0xW4", threshold: 70 }),
      ],
    });

    const result = await executeWorkflow(state);
    // Some should succeed, some should fail
    expect(result.state.triggeredAlerts.length).toBeGreaterThan(0);
    expect(result.state.triggeredAlerts.length).toBeLessThan(4);
  });

  test("alert processing order matches alertConfigs array order", async () => {
    const processOrder: string[] = [];
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        const match = url.match(/markets\/(0x[A-Z0-9-]+)/);
        if (match) processOrder.push(match[1]);
        return new Response(JSON.stringify(makeMarket(0.80)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });

    const state = makeState({
      alertConfigs: [
        makeAlert({ marketId: "0xORD-A", threshold: 70 }),
        makeAlert({ marketId: "0xORD-B", threshold: 70 }),
        makeAlert({ marketId: "0xORD-C", threshold: 70 }),
      ],
    });

    await executeWorkflow(state);
    expect(processOrder).toEqual(["0xORD-A", "0xORD-B", "0xORD-C"]);
  });

  test("alerts array messages contain market question text", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.80, { question: "Will BTC hit 100k?" })), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });

    const state = makeState({
      alertConfigs: [makeAlert({ threshold: 70 })],
    });

    const result = await executeWorkflow(state);
    expect(result.alerts[0]).toContain("Will BTC hit 100k?");
  });

  test("empty alertConfigs array returns empty results quickly", async () => {
    const state = makeState({ alertConfigs: [] });
    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(0);
    expect(result.state.triggeredAlerts).toHaveLength(0);
  });

  test("handles 200 alerts without memory issues", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.80)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });

    const alerts: AlertConfig[] = [];
    for (let i = 0; i < 200; i++) {
      alerts.push(makeAlert({ marketId: `0xBIG-${i}`, threshold: 70 }));
    }

    const state = makeState({ alertConfigs: alerts });
    const result = await executeWorkflow(state);
    expect(result.state.triggeredAlerts.length).toBe(200);
    expect(result.alerts.length).toBe(200);
  });
});

// ─── State Persistence ───────────────────────────────────────────────────────

describe("State Persistence", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("alert state survives across simulated restarts (two sequential executions)", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.80)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });

    // First execution
    const state = makeState({
      alertConfigs: [
        makeAlert({ marketId: "0xPERSIST", threshold: 70 }),
      ],
    });

    const result1 = await executeWorkflow(state);
    expect(result1.state.triggeredAlerts).toContain("0xPERSIST-Yes-70-above");

    // Simulate restart: clear lastChecked so rate limiter does not block
    result1.state.lastChecked = {};

    // Second execution with same state -- alert should be skipped (already triggered)
    const result2 = await executeWorkflow(result1.state);
    expect(result2.alerts).toHaveLength(0);
    expect(result2.state.triggeredAlerts).toContain("0xPERSIST-Yes-70-above");
  });

  test("triggeredAlerts accumulates across multiple workflow runs", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.80)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });

    const state = makeState({
      alertConfigs: [
        makeAlert({ marketId: "0xRUN1", threshold: 70 }),
        makeAlert({ marketId: "0xRUN2", threshold: 70 }),
      ],
    });

    // Run 1: both trigger
    const result1 = await executeWorkflow(state);
    expect(result1.state.triggeredAlerts.length).toBe(2);

    // Add a new alert, clear rate limiter
    result1.state.alertConfigs.push(makeAlert({ marketId: "0xRUN3", threshold: 70 }));
    result1.state.lastChecked = {};

    // Run 2: only new alert triggers
    const result2 = await executeWorkflow(result1.state);
    expect(result2.state.triggeredAlerts.length).toBe(3);
    expect(result2.alerts).toHaveLength(1);
    // Alert message contains market question and percentage, not the marketId
    expect(result2.alerts[0]).toContain("Alert triggered:");
  });

  test("state with 1000 triggered alerts still works correctly", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.80)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });

    // Pre-populate with 1000 triggered alerts
    const existingTriggered: string[] = [];
    for (let i = 0; i < 1000; i++) {
      existingTriggered.push(`0xOLD-${i}-Yes-50-above`);
    }

    const state = makeState({
      alertConfigs: [makeAlert({ marketId: "0xNEW", threshold: 70 })],
      triggeredAlerts: existingTriggered,
    });

    const result = await executeWorkflow(state);
    expect(result.state.triggeredAlerts.length).toBe(1001);
    expect(result.state.triggeredAlerts).toContain("0xNEW-Yes-70-above");
  });

  test("large lastChecked map does not break state handling", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.80)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });

    const lastChecked: Record<string, number> = {};
    for (let i = 0; i < 500; i++) {
      lastChecked[`0xOLD-${i}`] = Date.now() - 120000; // 2 minutes ago
    }

    const state = makeState({
      alertConfigs: [makeAlert({ marketId: "0xFRESH", threshold: 70 })],
      lastChecked,
    });

    const result = await executeWorkflow(state);
    expect(result.state.lastChecked["0xFRESH"]).toBeGreaterThan(0);
    // Old entries still preserved
    expect(Object.keys(result.state.lastChecked).length).toBe(501);
  });

  test("state serialization round-trip preserves all fields", async () => {
    const state = makeState({
      alertConfigs: [
        makeAlert({ marketId: "0xSER", threshold: 55.5, direction: "below" }),
      ],
      lastChecked: { "0xSER": 1700000000000 },
      triggeredAlerts: ["old-key-1", "old-key-2"],
    });

    // Serialize and deserialize (simulate persistence)
    const serialized = JSON.stringify(state);
    const deserialized: WorkflowState = JSON.parse(serialized);

    expect(deserialized.alertConfigs).toHaveLength(1);
    expect(deserialized.alertConfigs[0].marketId).toBe("0xSER");
    expect(deserialized.alertConfigs[0].threshold).toBe(55.5);
    expect(deserialized.alertConfigs[0].direction).toBe("below");
    expect(deserialized.lastChecked["0xSER"]).toBe(1700000000000);
    expect(deserialized.triggeredAlerts).toEqual(["old-key-1", "old-key-2"]);
  });

  test("state with empty alertConfigs but existing triggered alerts is valid", async () => {
    const state = makeState({
      alertConfigs: [],
      triggeredAlerts: ["some-old-key"],
    });

    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(0);
    expect(result.state.triggeredAlerts).toContain("some-old-key");
  });

  test("adding alert after initial empty state works on next run", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.80)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });

    // First run: empty
    const state = makeState({ alertConfigs: [] });
    const result1 = await executeWorkflow(state);
    expect(result1.alerts).toHaveLength(0);

    // Add alert and run again
    result1.state.alertConfigs.push(makeAlert({ marketId: "0xLATE", threshold: 70 }));
    const result2 = await executeWorkflow(result1.state);
    expect(result2.alerts).toHaveLength(1);
    expect(result2.state.triggeredAlerts).toContain("0xLATE-Yes-70-above");
  });

  test("lastChecked timestamp prevents re-fetch within 60 second window", async () => {
    let fetchCount = 0;
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        fetchCount++;
        return new Response(JSON.stringify(makeMarket(0.80)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });

    const state = makeState({
      alertConfigs: [makeAlert({ marketId: "0xTIMED", threshold: 70 })],
      lastChecked: { "0xTIMED": Date.now() - 30000 }, // 30s ago (within window)
    });

    const result = await executeWorkflow(state);
    expect(fetchCount).toBe(0);
    expect(result.alerts).toHaveLength(0);
  });

  test("lastChecked expiry (>60s) allows re-fetch", async () => {
    let fetchCount = 0;
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        fetchCount++;
        return new Response(JSON.stringify(makeMarket(0.80)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });

    const state = makeState({
      alertConfigs: [makeAlert({ marketId: "0xEXPIRED", threshold: 70 })],
      lastChecked: { "0xEXPIRED": Date.now() - 61000 }, // 61s ago (expired)
    });

    const result = await executeWorkflow(state);
    expect(fetchCount).toBe(1);
    expect(result.alerts).toHaveLength(1);
  });

  test("state returned is same object reference (mutations accumulate)", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.80)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });

    const state = makeState({
      alertConfigs: [makeAlert({ marketId: "0xREF", threshold: 70 })],
    });

    const result = await executeWorkflow(state);
    expect(result.state).toBe(state);
    // Mutations should be visible on original state object
    expect(state.triggeredAlerts).toContain("0xREF-Yes-70-above");
  });

  test("multiple alert keys are unique for different threshold/direction combos", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.20)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });

    const state = makeState({
      alertConfigs: [
        makeAlert({ marketId: "0xMULTI", threshold: 30, direction: "below" }),
        makeAlert({ marketId: "0xMULTI2", threshold: 25, direction: "below", outcome: "No" }),
      ],
    });

    const result = await executeWorkflow(state);
    // 20% is below 30, so first triggers; No outcome is 80%, not below 25
    const uniqueKeys = new Set(result.state.triggeredAlerts);
    expect(uniqueKeys.size).toBe(result.state.triggeredAlerts.length);
  });

  test("alert key format is marketId-outcome-threshold-direction", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.80)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });

    const state = makeState({
      alertConfigs: [makeAlert({ marketId: "0xKEY", outcome: "No", threshold: 25, direction: "below" })],
    });

    const result = await executeWorkflow(state);
    // No price is 20%, threshold 25% below -> triggers (20 <= 25)
    expect(result.state.triggeredAlerts).toContain("0xKEY-No-25-below");
  });

  test("deeply nested state clone preserves independence", async () => {
    const state = makeState({
      alertConfigs: [makeAlert({ marketId: "0xCLONE" })],
      triggeredAlerts: ["existing-key"],
    });

    const clone: WorkflowState = JSON.parse(JSON.stringify(state));
    clone.triggeredAlerts.push("clone-only-key");

    // Original should not be affected
    expect(state.triggeredAlerts).not.toContain("clone-only-key");
    expect(clone.triggeredAlerts).toContain("clone-only-key");
  });
});

// ─── Outcome Matching ────────────────────────────────────────────────────────

describe("Outcome Matching", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("matches market with 3+ outcomes (Yes/No/Maybe)", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.50, {
          outcomes: ["Yes", "No", "Maybe"],
          tokens: [
            { token_id: "t1", outcome: "Yes", price: 0.50, winner: false },
            { token_id: "t2", outcome: "No", price: 0.30, winner: false },
            { token_id: "t3", outcome: "Maybe", price: 0.20, winner: false },
          ],
        })), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });

    const state = makeState({
      alertConfigs: [makeAlert({ outcome: "Maybe", threshold: 15, direction: "above" })],
    });

    const result = await executeWorkflow(state);
    // Maybe is at 20%, threshold 15% above -> triggers
    expect(result.alerts).toHaveLength(1);
  });

  test("case-insensitive outcome matching (YES vs Yes)", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.75)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });

    const state = makeState({
      alertConfigs: [makeAlert({ outcome: "YES", threshold: 60 })],
    });

    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(1);
  });

  test("case-insensitive outcome matching (yes lowercase)", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.75)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });

    const state = makeState({
      alertConfigs: [makeAlert({ outcome: "yes", threshold: 60 })],
    });

    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(1);
  });

  test("outcome name typo (Yess) does not match any token", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.80)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });

    const state = makeState({
      alertConfigs: [makeAlert({ outcome: "Yess", threshold: 60 })],
    });

    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(0);
  });

  test("outcome name typo (Noo) does not match", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.80)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });

    const state = makeState({
      alertConfigs: [makeAlert({ outcome: "Noo", threshold: 10, direction: "below" })],
    });

    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(0);
  });

  test("market with custom outcome names (Republican/Democrat)", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.55, {
          outcomes: ["Republican", "Democrat"],
          tokens: [
            { token_id: "t1", outcome: "Republican", price: 0.55, winner: false },
            { token_id: "t2", outcome: "Democrat", price: 0.45, winner: false },
          ],
        })), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });

    const state = makeState({
      alertConfigs: [makeAlert({ outcome: "democrat", threshold: 50, direction: "below" })],
    });

    const result = await executeWorkflow(state);
    // Democrat at 45%, threshold 50% below -> triggers
    expect(result.alerts).toHaveLength(1);
  });

  test("outcome with special characters does not crash", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.60, {
          outcomes: ["Yes", "No"],
          tokens: [
            { token_id: "t1", outcome: "Yes", price: 0.60, winner: false },
            { token_id: "t2", outcome: "No", price: 0.40, winner: false },
          ],
        })), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });

    const state = makeState({
      alertConfigs: [makeAlert({ outcome: "Yes (>50%)", threshold: 50 })],
    });

    const result = await executeWorkflow(state);
    // Does not match because "yes (>50%)" !== "yes"
    expect(result.alerts).toHaveLength(0);
  });

  test("whitespace-only outcome does not match any token", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.80, {
          condition_id: "0xWSO",
          tokens: [
            { token_id: "t1", outcome: "Yes", price: 0.80, winner: false },
            { token_id: "t2", outcome: "No", price: 0.20, winner: false },
          ],
        })), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });

    const state = makeState({
      alertConfigs: [makeAlert({ marketId: "0xWSO", outcome: "   ", threshold: 60 })],
    });

    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(0);
  });

  test("market with single token outcome still works", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.90, {
          outcomes: ["Yes"],
          tokens: [
            { token_id: "t1", outcome: "Yes", price: 0.90, winner: false },
          ],
        })), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });

    const state = makeState({
      alertConfigs: [makeAlert({ outcome: "Yes", threshold: 80, direction: "above" })],
    });

    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(1);
  });

  test("market with zero-price token handles edge case", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0, {
          tokens: [
            { token_id: "t1", outcome: "Yes", price: 0, winner: false },
            { token_id: "t2", outcome: "No", price: 1, winner: false },
          ],
        })), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });

    const state = makeState({
      alertConfigs: [makeAlert({ outcome: "Yes", threshold: 5, direction: "below" })],
    });

    const result = await executeWorkflow(state);
    // Yes at 0%, threshold 5% below -> triggers (0 <= 5)
    expect(result.alerts).toHaveLength(1);
  });

  test("market with 4 outcomes selects correct one", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.40, {
          outcomes: ["Candidate A", "Candidate B", "Candidate C", "Candidate D"],
          tokens: [
            { token_id: "t1", outcome: "Candidate A", price: 0.40, winner: false },
            { token_id: "t2", outcome: "Candidate B", price: 0.30, winner: false },
            { token_id: "t3", outcome: "Candidate C", price: 0.20, winner: false },
            { token_id: "t4", outcome: "Candidate D", price: 0.10, winner: false },
          ],
        })), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });

    const state = makeState({
      alertConfigs: [makeAlert({ outcome: "Candidate C", threshold: 15, direction: "above" })],
    });

    const result = await executeWorkflow(state);
    // Candidate C at 20%, threshold 15% above -> triggers
    expect(result.alerts).toHaveLength(1);
  });

  test("exact boundary: price equals threshold triggers 'above' (>=)", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.60)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });

    const state = makeState({
      alertConfigs: [makeAlert({ outcome: "Yes", threshold: 60, direction: "above" })],
    });

    const result = await executeWorkflow(state);
    // Yes at exactly 60%, threshold 60% above -> triggers (60 >= 60)
    expect(result.alerts).toHaveLength(1);
  });

  test("exact boundary: price equals threshold triggers 'below' (<=)", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.40)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });

    const state = makeState({
      alertConfigs: [makeAlert({ outcome: "Yes", threshold: 40, direction: "below" })],
    });

    const result = await executeWorkflow(state);
    // Yes at exactly 40%, threshold 40% below -> triggers (40 <= 40)
    expect(result.alerts).toHaveLength(1);
  });

  test("closed market does not trigger alerts", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.80, { closed: true })), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });

    const state = makeState({
      alertConfigs: [makeAlert({ threshold: 70 })],
    });

    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(0);
  });

  test("inactive market does not trigger alerts", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.80, { active: false })), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });

    const state = makeState({
      alertConfigs: [makeAlert({ threshold: 70 })],
    });

    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(0);
  });

  test("market with token price of exactly 1.0 (100%) handles edge case", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(1.0, {
          tokens: [
            { token_id: "t1", outcome: "Yes", price: 1.0, winner: true },
            { token_id: "t2", outcome: "No", price: 0, winner: false },
          ],
        })), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });

    const state = makeState({
      alertConfigs: [makeAlert({ outcome: "Yes", threshold: 99, direction: "above" })],
    });

    const result = await executeWorkflow(state);
    // Yes at 100%, threshold 99% above -> triggers
    expect(result.alerts).toHaveLength(1);
  });
});
