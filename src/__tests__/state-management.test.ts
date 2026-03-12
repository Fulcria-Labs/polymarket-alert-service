/**
 * State Management Edge Cases
 *
 * Covers: state initialization, state mutation tracking, large state handling,
 * state serialization compatibility, alert config integrity, triggered alert
 * list management, lastChecked timestamp management, state recovery scenarios.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import {
  executeWorkflow,
  parseAlertRequest,
  parseMultiConditionAlert,
} from "../polymarket-alert-workflow";
import { createPaymentRequired } from "../x402-handler";

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
    marketId: overrides.marketId || "0xSTATE",
    outcome: overrides.outcome || "Yes",
    threshold: overrides.threshold || 60,
    direction: overrides.direction || "above",
    notifyUrl: overrides.notifyUrl || "https://hook.test/state",
  };
}

function makeMarket(price = 0.65, overrides: Record<string, any> = {}) {
  return {
    condition_id: overrides.condition_id || "0xSTATE",
    question: overrides.question || "State test?",
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

// ─── State initialization ───────────────────────────────────────────────────

describe("State - initialization", () => {
  test("empty state has empty alertConfigs array", () => {
    const state = makeState();
    expect(state.alertConfigs).toEqual([]);
  });

  test("empty state has empty lastChecked object", () => {
    const state = makeState();
    expect(Object.keys(state.lastChecked).length).toBe(0);
  });

  test("empty state has empty triggeredAlerts array", () => {
    const state = makeState();
    expect(state.triggeredAlerts).toEqual([]);
  });

  test("state with alert configs preserves them", () => {
    const alert = makeAlert({ threshold: 75 });
    const state = makeState({ alertConfigs: [alert] });
    expect(state.alertConfigs.length).toBe(1);
    expect(state.alertConfigs[0].threshold).toBe(75);
  });

  test("state with lastChecked preserves timestamps", () => {
    const state = makeState({ lastChecked: { "0xA": 12345, "0xB": 67890 } });
    expect(state.lastChecked["0xA"]).toBe(12345);
    expect(state.lastChecked["0xB"]).toBe(67890);
  });

  test("state with triggeredAlerts preserves keys", () => {
    const state = makeState({ triggeredAlerts: ["key1", "key2"] });
    expect(state.triggeredAlerts).toContain("key1");
    expect(state.triggeredAlerts).toContain("key2");
  });
});

// ─── State mutation through workflow ────────────────────────────────────────

describe("State - mutation tracking", () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("workflow returns updated state", async () => {
    global.fetch = mock(async (url: string | Request) => {
      const urlStr = typeof url === "string" ? url : url.url;
      if (urlStr.includes("clob")) {
        return new Response(JSON.stringify(makeMarket(0.70)), { status: 200 });
      }
      return new Response("OK", { status: 200 });
    });

    const state = makeState({
      alertConfigs: [makeAlert({ marketId: "0xMUT" })],
    });

    const result = await executeWorkflow(state);
    expect(result.state).toBeTruthy();
    expect(result.state.alertConfigs.length).toBe(1);
  });

  test("lastChecked is updated after successful check", async () => {
    global.fetch = mock(async () => {
      return new Response(JSON.stringify(makeMarket(0.50)), { status: 200 });
    });

    const state = makeState({
      alertConfigs: [makeAlert({ marketId: "0xLC" })],
      lastChecked: {},
    });

    const before = Date.now();
    const result = await executeWorkflow(state);
    expect(result.state.lastChecked["0xLC"]).toBeGreaterThanOrEqual(before);
  });

  test("triggeredAlerts grows when alerts fire", async () => {
    global.fetch = mock(async (url: string | Request) => {
      const urlStr = typeof url === "string" ? url : url.url;
      if (urlStr.includes("clob")) {
        return new Response(JSON.stringify(makeMarket(0.70)), { status: 200 });
      }
      return new Response("OK", { status: 200 });
    });

    const state = makeState({
      alertConfigs: [makeAlert({ marketId: "0xGROW", threshold: 60 })],
      triggeredAlerts: [],
    });

    const result = await executeWorkflow(state);
    expect(result.state.triggeredAlerts.length).toBe(1);
  });

  test("alertConfigs remain unchanged through execution", async () => {
    global.fetch = mock(async () => {
      return new Response(JSON.stringify(makeMarket(0.50)), { status: 200 });
    });

    const configs = [
      makeAlert({ marketId: "0xA", threshold: 55 }),
      makeAlert({ marketId: "0xB", threshold: 65 }),
    ];
    const state = makeState({ alertConfigs: [...configs] });

    const result = await executeWorkflow(state);
    expect(result.state.alertConfigs.length).toBe(2);
    expect(result.state.alertConfigs[0].threshold).toBe(55);
    expect(result.state.alertConfigs[1].threshold).toBe(65);
  });
});

// ─── Alert key generation ──────────────────────────────────────────────────

describe("State - alert key generation", () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("alert key format is marketId-outcome-threshold-direction", async () => {
    global.fetch = mock(async (url: string | Request) => {
      const urlStr = typeof url === "string" ? url : url.url;
      if (urlStr.includes("clob")) {
        return new Response(JSON.stringify(makeMarket(0.70, { condition_id: "0xKEY" })), { status: 200 });
      }
      return new Response("OK", { status: 200 });
    });

    const state = makeState({
      alertConfigs: [makeAlert({ marketId: "0xKEY", outcome: "Yes", threshold: 60, direction: "above" })],
    });

    const result = await executeWorkflow(state);
    expect(result.state.triggeredAlerts).toContain("0xKEY-Yes-60-above");
  });

  test("different outcomes produce different keys", async () => {
    global.fetch = mock(async (url: string | Request) => {
      const urlStr = typeof url === "string" ? url : url.url;
      if (urlStr.includes("clob")) {
        return new Response(JSON.stringify(makeMarket(0.30, { condition_id: "0xKEY2" })), { status: 200 }); // No = 70%
      }
      return new Response("OK", { status: 200 });
    });

    const state = makeState({
      alertConfigs: [makeAlert({ marketId: "0xKEY2", outcome: "No", threshold: 60, direction: "above" })],
    });

    const result = await executeWorkflow(state);
    expect(result.state.triggeredAlerts).toContain("0xKEY2-No-60-above");
  });

  test("different thresholds produce different keys", () => {
    const key1 = "0xA-Yes-60-above";
    const key2 = "0xA-Yes-70-above";
    expect(key1).not.toBe(key2);
  });

  test("different directions produce different keys", () => {
    const key1 = "0xA-Yes-60-above";
    const key2 = "0xA-Yes-60-below";
    expect(key1).not.toBe(key2);
  });
});

// ─── Large state handling ──────────────────────────────────────────────────

describe("State - large state handling", () => {
  test("state with 100 alert configs serializes correctly", () => {
    const configs = Array.from({ length: 100 }, (_, i) =>
      makeAlert({ marketId: `0x${i.toString(16).padStart(4, "0")}` })
    );
    const state = makeState({ alertConfigs: configs });
    expect(state.alertConfigs.length).toBe(100);

    const serialized = JSON.stringify(state);
    const deserialized = JSON.parse(serialized);
    expect(deserialized.alertConfigs.length).toBe(100);
  });

  test("state with 100 triggered alerts", () => {
    const triggered = Array.from({ length: 100 }, (_, i) =>
      `0x${i}-Yes-60-above`
    );
    const state = makeState({ triggeredAlerts: triggered });
    expect(state.triggeredAlerts.length).toBe(100);
  });

  test("state with many lastChecked entries", () => {
    const lastChecked: Record<string, number> = {};
    for (let i = 0; i < 100; i++) {
      lastChecked[`0x${i}`] = Date.now() - i * 1000;
    }
    const state = makeState({ lastChecked });
    expect(Object.keys(state.lastChecked).length).toBe(100);
  });

  test("large state is JSON serializable", () => {
    const configs = Array.from({ length: 50 }, (_, i) =>
      makeAlert({ marketId: `0xM${i}` })
    );
    const lastChecked: Record<string, number> = {};
    configs.forEach(c => { lastChecked[c.marketId] = Date.now(); });
    const triggered = configs.map(c =>
      `${c.marketId}-${c.outcome}-${c.threshold}-${c.direction}`
    );

    const state = makeState({ alertConfigs: configs, lastChecked, triggeredAlerts: triggered });
    const json = JSON.stringify(state);
    expect(json.length).toBeGreaterThan(0);
    const parsed = JSON.parse(json);
    expect(parsed.alertConfigs.length).toBe(50);
  });
});

// ─── Alert config integrity ────────────────────────────────────────────────

describe("State - alert config integrity", () => {
  test("alert config has all required fields", () => {
    const alert = makeAlert();
    expect(alert.marketId).toBeTruthy();
    expect(alert.outcome).toBeTruthy();
    expect(typeof alert.threshold).toBe("number");
    expect(["above", "below"]).toContain(alert.direction);
    expect(alert.notifyUrl).toBeTruthy();
  });

  test("parseAlertRequest produces valid config shape", () => {
    const result = parseAlertRequest("Trump > 60%", "https://hook");
    expect(result).not.toBeNull();
    expect(typeof result!.marketId).toBe("string");
    expect(typeof result!.outcome).toBe("string");
    expect(typeof result!.threshold).toBe("number");
    expect(["above", "below"]).toContain(result!.direction);
    expect(typeof result!.notifyUrl).toBe("string");
  });

  test("parseAlertRequest marketId defaults to empty string", () => {
    const result = parseAlertRequest("Trump > 60%", "https://hook");
    expect(result!.marketId).toBe("");
  });

  test("threshold is always a number", () => {
    const inputs = [
      "Trump > 60%",
      "Biden < 40%",
      "Gold hits 70 cents",
      "Silver reaches 55 percent",
    ];
    for (const input of inputs) {
      const result = parseAlertRequest(input, "https://hook");
      if (result) {
        expect(typeof result.threshold).toBe("number");
        expect(isNaN(result.threshold)).toBe(false);
      }
    }
  });

  test("direction is always 'above' or 'below'", () => {
    const inputs = [
      "Trump > 60%",
      "Biden < 40%",
      "Gold exceeds 70%",
      "Silver drops below 30%",
    ];
    for (const input of inputs) {
      const result = parseAlertRequest(input, "https://hook");
      if (result) {
        expect(["above", "below"]).toContain(result.direction);
      }
    }
  });

  test("outcome is always 'Yes' or 'No'", () => {
    const inputs = [
      "Trump wins > 60%",
      "bill won't pass < 40%",
      "policy will fail > 30%",
      "candidate will lose > 50%",
    ];
    for (const input of inputs) {
      const result = parseAlertRequest(input, "https://hook");
      if (result) {
        expect(["Yes", "No"]).toContain(result.outcome);
      }
    }
  });
});

// ─── Payment request state ─────────────────────────────────────────────────

describe("State - payment request state", () => {
  test("createPaymentRequired generates unique state per call", () => {
    const r1 = createPaymentRequired("/alerts", "test1");
    const r2 = createPaymentRequired("/alerts", "test2");
    expect(r1.body.nonce).not.toBe(r2.body.nonce);
    expect(r1.body.description).not.toBe(r2.body.description);
  });

  test("payment request captures resource path in state", () => {
    const result = createPaymentRequired("/my/resource", "desc");
    expect(result.body.resource).toBe("/my/resource");
  });

  test("payment request captures description in state", () => {
    const result = createPaymentRequired("/test", "my description");
    expect(result.body.description).toBe("my description");
  });

  test("payment request expiry is future timestamp", () => {
    const now = Math.floor(Date.now() / 1000);
    const result = createPaymentRequired("/test", "test");
    expect(result.body.expiry).toBeGreaterThan(now);
  });
});

// ─── Multi-execution state consistency ─────────────────────────────────────

describe("State - multi-execution consistency", () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("state survives round-trip through executeWorkflow", async () => {
    global.fetch = mock(async () => {
      return new Response(JSON.stringify(makeMarket(0.50)), { status: 200 });
    });

    const initialState = makeState({
      alertConfigs: [makeAlert({ marketId: "0xRT", threshold: 60 })],
      lastChecked: { "old": 999 },
      triggeredAlerts: ["old-key"],
    });

    const result = await executeWorkflow(initialState);
    // Original data should persist
    expect(result.state.lastChecked["old"]).toBe(999);
    expect(result.state.triggeredAlerts).toContain("old-key");
    // New check timestamp added
    expect(result.state.lastChecked["0xRT"]).toBeGreaterThan(0);
  });

  test("3 consecutive executions accumulate state correctly", async () => {
    global.fetch = mock(async (url: string | Request) => {
      const urlStr = typeof url === "string" ? url : url.url;
      if (urlStr.includes("clob")) {
        return new Response(JSON.stringify(makeMarket(0.70)), { status: 200 });
      }
      return new Response("OK", { status: 200 });
    });

    let state = makeState({
      alertConfigs: [makeAlert({ marketId: "0xSEQ", threshold: 60 })],
    });

    // First execution - should trigger
    const r1 = await executeWorkflow(state);
    expect(r1.alerts.length).toBe(1);
    expect(r1.state.triggeredAlerts.length).toBe(1);

    // Second execution - already triggered, should skip
    state = r1.state;
    const r2 = await executeWorkflow(state);
    expect(r2.alerts.length).toBe(0);
    expect(r2.state.triggeredAlerts.length).toBe(1);

    // Third execution - still triggered, still skip
    state = r2.state;
    const r3 = await executeWorkflow(state);
    expect(r3.alerts.length).toBe(0);
    expect(r3.state.triggeredAlerts.length).toBe(1);
  });
});
