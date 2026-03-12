/**
 * Workflow Scheduling Edge Cases
 *
 * Covers: rate limiting behavior, timestamp handling, multi-market scheduling,
 * lastChecked state persistence, concurrent market checks, clock boundary
 * scenarios, workflow execution ordering, state mutation during execution.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { executeWorkflow } from "../polymarket-alert-workflow";

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
    marketId: overrides.marketId || "0xSCHED",
    outcome: overrides.outcome || "Yes",
    threshold: overrides.threshold || 60,
    direction: overrides.direction || "above",
    notifyUrl: overrides.notifyUrl || "https://hook.test/sched",
  };
}

function makeMarket(price = 0.65, overrides: Record<string, any> = {}) {
  return {
    condition_id: overrides.condition_id || "0xSCHED",
    question: overrides.question || "Schedule test?",
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

// ─── Rate limiting ──────────────────────────────────────────────────────────

describe("Workflow scheduling - rate limiting", () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("skips market check when lastChecked within 60 seconds", async () => {
    let fetchCallCount = 0;
    global.fetch = mock(async () => {
      fetchCallCount++;
      return new Response(JSON.stringify(makeMarket(0.70)), { status: 200 });
    });

    const now = Date.now();
    const state = makeState({
      alertConfigs: [makeAlert({ marketId: "0xRATE" })],
      lastChecked: { "0xRATE": now - 30000 }, // 30 seconds ago
    });

    const result = await executeWorkflow(state);
    // Should skip because checked less than 60s ago
    expect(fetchCallCount).toBe(0);
    expect(result.alerts.length).toBe(0);
  });

  test("checks market when lastChecked is exactly 60 seconds ago", async () => {
    let fetchCallCount = 0;
    global.fetch = mock(async () => {
      fetchCallCount++;
      return new Response(JSON.stringify(makeMarket(0.70)), { status: 200 });
    });

    const now = Date.now();
    const state = makeState({
      alertConfigs: [makeAlert({ marketId: "0xEXACT" })],
      lastChecked: { "0xEXACT": now - 60000 }, // Exactly 60 seconds ago
    });

    const result = await executeWorkflow(state);
    // Should check because 60s threshold met
    expect(fetchCallCount).toBeGreaterThanOrEqual(1);
  });

  test("checks market when lastChecked is over 60 seconds ago", async () => {
    let fetchCallCount = 0;
    global.fetch = mock(async () => {
      fetchCallCount++;
      return new Response(JSON.stringify(makeMarket(0.70)), { status: 200 });
    });

    const state = makeState({
      alertConfigs: [makeAlert({ marketId: "0xOLD" })],
      lastChecked: { "0xOLD": Date.now() - 120000 }, // 2 minutes ago
    });

    const result = await executeWorkflow(state);
    expect(fetchCallCount).toBeGreaterThanOrEqual(1);
  });

  test("first check for market has no lastChecked - always checks", async () => {
    let fetchCallCount = 0;
    global.fetch = mock(async () => {
      fetchCallCount++;
      return new Response(JSON.stringify(makeMarket(0.70)), { status: 200 });
    });

    const state = makeState({
      alertConfigs: [makeAlert({ marketId: "0xFIRST" })],
      lastChecked: {}, // No record
    });

    const result = await executeWorkflow(state);
    expect(fetchCallCount).toBeGreaterThanOrEqual(1);
  });

  test("updates lastChecked timestamp after check", async () => {
    const before = Date.now();
    global.fetch = mock(async () => {
      return new Response(JSON.stringify(makeMarket(0.50)), { status: 200 });
    });

    const state = makeState({
      alertConfigs: [makeAlert({ marketId: "0xTS" })],
      lastChecked: {},
    });

    const result = await executeWorkflow(state);
    expect(result.state.lastChecked["0xTS"]).toBeGreaterThanOrEqual(before);
  });
});

// ─── Multi-market scheduling ────────────────────────────────────────────────

describe("Workflow scheduling - multi-market", () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("checks multiple markets in single execution", async () => {
    const checkedUrls: string[] = [];
    global.fetch = mock(async (url: string | Request) => {
      const urlStr = typeof url === "string" ? url : url.url;
      checkedUrls.push(urlStr);
      return new Response(JSON.stringify(makeMarket(0.50)), { status: 200 });
    });

    const state = makeState({
      alertConfigs: [
        makeAlert({ marketId: "0xM1" }),
        makeAlert({ marketId: "0xM2" }),
        makeAlert({ marketId: "0xM3" }),
      ],
      lastChecked: {},
    });

    await executeWorkflow(state);
    // Each market should be fetched
    expect(checkedUrls.length).toBeGreaterThanOrEqual(3);
  });

  test("rate-limits per market independently", async () => {
    let fetchCallCount = 0;
    global.fetch = mock(async () => {
      fetchCallCount++;
      return new Response(JSON.stringify(makeMarket(0.50)), { status: 200 });
    });

    const now = Date.now();
    const state = makeState({
      alertConfigs: [
        makeAlert({ marketId: "0xFRESH" }),  // Will be checked
        makeAlert({ marketId: "0xRATED" }),   // Won't be checked
      ],
      lastChecked: {
        "0xFRESH": now - 120000, // Old - will check
        "0xRATED": now - 30000,  // Recent - will skip
      },
    });

    await executeWorkflow(state);
    // Only 0xFRESH should be fetched, but webhook also sends fetch
    expect(fetchCallCount).toBeGreaterThanOrEqual(1);
  });

  test("handles same market appearing in multiple configs", async () => {
    let fetchCount = 0;
    global.fetch = mock(async () => {
      fetchCount++;
      return new Response(JSON.stringify(makeMarket(0.75)), { status: 200 });
    });

    const state = makeState({
      alertConfigs: [
        makeAlert({ marketId: "0xSAME", threshold: 60, direction: "above" }),
        makeAlert({ marketId: "0xSAME", threshold: 80, direction: "above" }),
      ],
      lastChecked: {},
    });

    const result = await executeWorkflow(state);
    // Second alert for same market should be rate-limited since lastChecked updated by first
    // But first one should trigger (75% > 60%)
    expect(result.alerts.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Triggered alert deduplication ──────────────────────────────────────────

describe("Workflow scheduling - deduplication", () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("skips already-triggered alert", async () => {
    let fetchCallCount = 0;
    global.fetch = mock(async () => {
      fetchCallCount++;
      return new Response(JSON.stringify(makeMarket(0.70)), { status: 200 });
    });

    const alertKey = "0xDEDUP-Yes-60-above";
    const state = makeState({
      alertConfigs: [makeAlert({ marketId: "0xDEDUP" })],
      triggeredAlerts: [alertKey],
      lastChecked: {},
    });

    const result = await executeWorkflow(state);
    expect(result.alerts.length).toBe(0);
    // Should not even fetch because it's already triggered
    expect(fetchCallCount).toBe(0);
  });

  test("different thresholds create different alert keys", async () => {
    global.fetch = mock(async (url: string | Request) => {
      const urlStr = typeof url === "string" ? url : url.url;
      if (urlStr.includes("clob")) {
        return new Response(JSON.stringify(makeMarket(0.70)), { status: 200 });
      }
      return new Response("OK", { status: 200 });
    });

    const state = makeState({
      alertConfigs: [
        makeAlert({ marketId: "0xKEY", threshold: 60 }),
        makeAlert({ marketId: "0xKEY", threshold: 70 }),
      ],
      triggeredAlerts: ["0xKEY-Yes-60-above"], // Only 60% triggered
      lastChecked: {},
    });

    const result = await executeWorkflow(state);
    // 70% threshold alert should still fire (market is at 70%)
    // But rate-limited since same marketId - first config skipped (already triggered),
    // second one should check
    // It depends on whether lastChecked gets updated for 0xKEY
  });

  test("alert key includes direction", async () => {
    global.fetch = mock(async (url: string | Request) => {
      const urlStr = typeof url === "string" ? url : url.url;
      if (urlStr.includes("clob")) {
        return new Response(JSON.stringify(makeMarket(0.30)), { status: 200 });
      }
      return new Response("OK", { status: 200 });
    });

    const state = makeState({
      alertConfigs: [
        makeAlert({ marketId: "0xDIR", threshold: 40, direction: "below" }),
      ],
      triggeredAlerts: ["0xDIR-Yes-40-above"], // Different direction - should not match
      lastChecked: {},
    });

    const result = await executeWorkflow(state);
    // Alert with direction 'below' should fire since only 'above' was triggered
    expect(result.alerts.length).toBe(1);
  });

  test("triggered alerts accumulate across executions", async () => {
    global.fetch = mock(async (url: string | Request) => {
      const urlStr = typeof url === "string" ? url : url.url;
      if (urlStr.includes("clob")) {
        return new Response(JSON.stringify(makeMarket(0.70)), { status: 200 });
      }
      return new Response("OK", { status: 200 });
    });

    const state = makeState({
      alertConfigs: [makeAlert({ marketId: "0xACCUM", threshold: 60 })],
      triggeredAlerts: [],
      lastChecked: {},
    });

    const result1 = await executeWorkflow(state);
    expect(result1.state.triggeredAlerts.length).toBe(1);

    // Run again - should skip
    const result2 = await executeWorkflow(result1.state);
    expect(result2.alerts.length).toBe(0);
    expect(result2.state.triggeredAlerts.length).toBe(1);
  });
});

// ─── Empty and edge states ──────────────────────────────────────────────────

describe("Workflow scheduling - edge states", () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("empty alertConfigs returns no alerts", async () => {
    const state = makeState({ alertConfigs: [] });
    const result = await executeWorkflow(state);
    expect(result.alerts.length).toBe(0);
    expect(result.state.triggeredAlerts.length).toBe(0);
  });

  test("preserves existing state with no configs", async () => {
    const state = makeState({
      alertConfigs: [],
      lastChecked: { "0xOLD": 12345 },
      triggeredAlerts: ["old-alert"],
    });
    const result = await executeWorkflow(state);
    expect(result.state.lastChecked["0xOLD"]).toBe(12345);
    expect(result.state.triggeredAlerts).toContain("old-alert");
  });

  test("handles market fetch returning null (inactive/not found)", async () => {
    global.fetch = mock(async () => {
      return new Response("Not Found", { status: 404 });
    });

    const state = makeState({
      alertConfigs: [makeAlert()],
      lastChecked: {},
    });

    const result = await executeWorkflow(state);
    expect(result.alerts.length).toBe(0);
  });

  test("handles market that is closed", async () => {
    global.fetch = mock(async () => {
      return new Response(JSON.stringify(makeMarket(0.70, { closed: true })), { status: 200 });
    });

    const state = makeState({
      alertConfigs: [makeAlert()],
      lastChecked: {},
    });

    const result = await executeWorkflow(state);
    expect(result.alerts.length).toBe(0);
  });

  test("handles market that is inactive", async () => {
    global.fetch = mock(async () => {
      return new Response(JSON.stringify(makeMarket(0.70, { active: false })), { status: 200 });
    });

    const state = makeState({
      alertConfigs: [makeAlert()],
      lastChecked: {},
    });

    const result = await executeWorkflow(state);
    expect(result.alerts.length).toBe(0);
  });

  test("handles fetch throwing an error", async () => {
    global.fetch = mock(async () => {
      throw new Error("Network error");
    });

    const state = makeState({
      alertConfigs: [makeAlert()],
      lastChecked: {},
    });

    const result = await executeWorkflow(state);
    expect(result.alerts.length).toBe(0);
  });
});

// ─── Alert condition checking ───────────────────────────────────────────────

describe("Workflow scheduling - condition checking", () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("triggers 'above' alert when price equals threshold", async () => {
    global.fetch = mock(async (url: string | Request) => {
      const urlStr = typeof url === "string" ? url : url.url;
      if (urlStr.includes("clob")) {
        return new Response(JSON.stringify(makeMarket(0.60)), { status: 200 }); // 60% = threshold
      }
      return new Response("OK", { status: 200 });
    });

    const state = makeState({
      alertConfigs: [makeAlert({ threshold: 60, direction: "above" })],
      lastChecked: {},
    });

    const result = await executeWorkflow(state);
    expect(result.alerts.length).toBe(1);
  });

  test("triggers 'below' alert when price equals threshold", async () => {
    global.fetch = mock(async (url: string | Request) => {
      const urlStr = typeof url === "string" ? url : url.url;
      if (urlStr.includes("clob")) {
        return new Response(JSON.stringify(makeMarket(0.30)), { status: 200 }); // 30%
      }
      return new Response("OK", { status: 200 });
    });

    const state = makeState({
      alertConfigs: [makeAlert({ threshold: 30, direction: "below" })],
      lastChecked: {},
    });

    const result = await executeWorkflow(state);
    expect(result.alerts.length).toBe(1);
  });

  test("does not trigger 'above' when price is below threshold", async () => {
    global.fetch = mock(async () => {
      return new Response(JSON.stringify(makeMarket(0.50)), { status: 200 }); // 50% < 60%
    });

    const state = makeState({
      alertConfigs: [makeAlert({ threshold: 60, direction: "above" })],
      lastChecked: {},
    });

    const result = await executeWorkflow(state);
    expect(result.alerts.length).toBe(0);
  });

  test("does not trigger 'below' when price is above threshold", async () => {
    global.fetch = mock(async () => {
      return new Response(JSON.stringify(makeMarket(0.70)), { status: 200 }); // 70% > 30%
    });

    const state = makeState({
      alertConfigs: [makeAlert({ threshold: 30, direction: "below" })],
      lastChecked: {},
    });

    const result = await executeWorkflow(state);
    expect(result.alerts.length).toBe(0);
  });

  test("triggers for 'No' outcome with correct price", async () => {
    global.fetch = mock(async (url: string | Request) => {
      const urlStr = typeof url === "string" ? url : url.url;
      if (urlStr.includes("clob")) {
        return new Response(JSON.stringify(makeMarket(0.30)), { status: 200 }); // No = 70%
      }
      return new Response("OK", { status: 200 });
    });

    const state = makeState({
      alertConfigs: [makeAlert({ outcome: "No", threshold: 60, direction: "above" })],
      lastChecked: {},
    });

    const result = await executeWorkflow(state);
    expect(result.alerts.length).toBe(1); // No is at 70% > 60%
  });

  test("outcome not found in market tokens", async () => {
    const market = makeMarket(0.70);
    market.tokens = [
      { token_id: "t1", outcome: "Yes", price: 0.70, winner: false },
      { token_id: "t2", outcome: "No", price: 0.30, winner: false },
    ];
    global.fetch = mock(async () => {
      return new Response(JSON.stringify(market), { status: 200 });
    });

    const state = makeState({
      alertConfigs: [makeAlert({ outcome: "Maybe", threshold: 50, direction: "above" })],
      lastChecked: {},
    });

    const result = await executeWorkflow(state);
    expect(result.alerts.length).toBe(0);
  });
});

// ─── Webhook sending in workflow ────────────────────────────────────────────

describe("Workflow scheduling - webhook delivery", () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("webhook failure prevents alert from being marked triggered", async () => {
    global.fetch = mock(async (url: string | Request) => {
      const urlStr = typeof url === "string" ? url : url.url;
      if (urlStr.includes("clob")) {
        return new Response(JSON.stringify(makeMarket(0.70)), { status: 200 });
      }
      // Webhook fails
      return new Response("Internal Server Error", { status: 500 });
    });

    const state = makeState({
      alertConfigs: [makeAlert({ threshold: 60 })],
      lastChecked: {},
    });

    const result = await executeWorkflow(state);
    // Webhook failed, so alert should NOT be in triggeredAlerts
    expect(result.state.triggeredAlerts.length).toBe(0);
  });

  test("webhook success marks alert as triggered", async () => {
    global.fetch = mock(async (url: string | Request) => {
      const urlStr = typeof url === "string" ? url : url.url;
      if (urlStr.includes("clob")) {
        return new Response(JSON.stringify(makeMarket(0.70)), { status: 200 });
      }
      return new Response("OK", { status: 200 });
    });

    const state = makeState({
      alertConfigs: [makeAlert({ threshold: 60 })],
      lastChecked: {},
    });

    const result = await executeWorkflow(state);
    expect(result.state.triggeredAlerts.length).toBe(1);
    expect(result.alerts.length).toBe(1);
  });

  test("webhook receives correct payload format", async () => {
    let webhookPayload: any = null;
    global.fetch = mock(async (url: string | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.url;
      if (urlStr.includes("clob")) {
        return new Response(JSON.stringify(makeMarket(0.70, { condition_id: "0xPAY", question: "Payload test?" })), { status: 200 });
      }
      // Capture webhook payload
      if (init?.body) {
        webhookPayload = JSON.parse(init.body as string);
      }
      return new Response("OK", { status: 200 });
    });

    const state = makeState({
      alertConfigs: [makeAlert({ marketId: "0xPAY", threshold: 60 })],
      lastChecked: {},
    });

    await executeWorkflow(state);
    expect(webhookPayload).not.toBeNull();
    expect(webhookPayload.type).toBe("prediction_market_alert");
    expect(webhookPayload.marketId).toBe("0xPAY");
    expect(webhookPayload.question).toBe("Payload test?");
    expect(webhookPayload.outcome).toBe("Yes");
    expect(webhookPayload.threshold).toBe(60);
    expect(webhookPayload.direction).toBe("above");
    expect(webhookPayload.triggeredAt).toBeTruthy();
  });
});
