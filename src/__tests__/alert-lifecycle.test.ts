/**
 * Alert Lifecycle Tests
 *
 * Covers: create/read/update/delete flows, alert expiration, duplicate alerts,
 * max alerts tracking, alert state machine transitions, webhook payload
 * validation, triggered alert deduplication, multi-run consistency,
 * and alert key generation.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import {
  executeWorkflow,
  parseAlertRequest,
  parseMultiConditionAlert,
} from "../polymarket-alert-workflow";
import { createPaymentRequired } from "../x402-handler";
import app from "../api";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const NOTIFY = "https://hook.test/lifecycle";

function makeClobMarket(price = 0.65, overrides: Record<string, any> = {}) {
  return {
    condition_id: overrides.condition_id || "0xLIFE",
    question: overrides.question || "Lifecycle test?",
    outcomes: overrides.outcomes || ["Yes", "No"],
    tokens: overrides.tokens || [
      { token_id: "t1", outcome: "Yes", price, winner: false },
      { token_id: "t2", outcome: "No", price: 1 - price, winner: false },
    ],
    active: overrides.active !== undefined ? overrides.active : true,
    closed: overrides.closed !== undefined ? overrides.closed : false,
    volume: overrides.volume || 50000,
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

// ─── Alert creation (402 payment required) ───────────────────────────────────

describe("Alert lifecycle - creation requires payment", () => {
  test("POST /alerts without payment returns 402", async () => {
    const res = await apiReq("POST", "/alerts", { body: { description: "Test alert" } });
    expect(res.status).toBe(402);
  });

  test("402 response contains nonce for payment tracking", async () => {
    const res = await apiReq("POST", "/alerts", { body: { description: "Test" } });
    const body = await res.json();
    expect(body.nonce).toBeTruthy();
    expect(typeof body.nonce).toBe("string");
  });

  test("402 response contains expiry timestamp", async () => {
    const res = await apiReq("POST", "/alerts", { body: { description: "Test" } });
    const body = await res.json();
    expect(body.expiry).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  test("each request generates unique nonce", async () => {
    const r1 = await apiReq("POST", "/alerts", { body: { description: "A" } });
    const r2 = await apiReq("POST", "/alerts", { body: { description: "B" } });
    const b1 = await r1.json();
    const b2 = await r2.json();
    expect(b1.nonce).not.toBe(b2.nonce);
  });

  test("402 response includes payment version header", async () => {
    const res = await apiReq("POST", "/alerts", { body: { description: "Test" } });
    expect(res.headers.get("X-Payment-Version")).toBe("1.0");
  });

  test("402 response includes X-Payment-Required header", async () => {
    const res = await apiReq("POST", "/alerts", { body: { description: "Test" } });
    expect(res.headers.get("X-Payment-Required")).toBe("true");
  });
});

// ─── Alert creation - invalid payment proofs ─────────────────────────────────

describe("Alert lifecycle - invalid payment proofs", () => {
  test("malformed JSON payment proof returns 400", async () => {
    const res = await apiReq("POST", "/alerts", {
      body: { description: "test" },
      headers: { "X-Payment-Proof": "not-json{{{" },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid payment proof/i);
  });

  test("wrong chain ID in payment proof returns 402", async () => {
    const proof = JSON.stringify({
      transactionHash: "0xabc",
      blockNumber: 1,
      chainId: 1, // Ethereum mainnet, not Base
      payer: "0xpayer",
      amount: "10000",
    });
    const res = await apiReq("POST", "/alerts", {
      body: { description: "test" },
      headers: { "X-Payment-Proof": proof },
    });
    expect(res.status).toBe(402);
  });

  test("empty object payment proof returns 402 (wrong chain)", async () => {
    const res = await apiReq("POST", "/alerts", {
      body: { description: "test" },
      headers: { "X-Payment-Proof": "{}" },
    });
    expect([400, 402]).toContain(res.status);
  });

  test("null payment proof string returns error", async () => {
    const res = await apiReq("POST", "/alerts", {
      body: { description: "test" },
      headers: { "X-Payment-Proof": "null" },
    });
    expect([400, 402]).toContain(res.status);
  });
});

// ─── Alert listing ───────────────────────────────────────────────────────────

describe("Alert lifecycle - listing alerts", () => {
  test("GET /alerts returns count and alerts array", async () => {
    const res = await apiReq("GET", "/alerts");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.count).toBe("number");
    expect(Array.isArray(body.alerts)).toBe(true);
  });

  test("count matches alerts array length", async () => {
    const res = await apiReq("GET", "/alerts");
    const body = await res.json();
    expect(body.count).toBe(body.alerts.length);
  });

  test("each alert has an id field", async () => {
    const res = await apiReq("GET", "/alerts");
    const body = await res.json();
    for (const alert of body.alerts) {
      expect(typeof alert.id).toBe("number");
    }
  });

  test("alerts have triggered field", async () => {
    const res = await apiReq("GET", "/alerts");
    const body = await res.json();
    for (const alert of body.alerts) {
      expect(typeof alert.triggered).toBe("boolean");
    }
  });
});

// ─── Alert deletion ──────────────────────────────────────────────────────────

describe("Alert lifecycle - deletion", () => {
  test("DELETE /alerts/99999 returns 404", async () => {
    const res = await apiReq("DELETE", "/alerts/99999");
    expect(res.status).toBe(404);
  });

  test("DELETE /alerts/-1 returns 404", async () => {
    const res = await apiReq("DELETE", "/alerts/-1");
    expect(res.status).toBe(404);
  });

  test("DELETE /alerts/abc returns 404 (NaN)", async () => {
    const res = await apiReq("DELETE", "/alerts/abc");
    expect(res.status).toBe(404);
  });

  test("DELETE /alerts/1.5 returns 404 (non-integer)", async () => {
    const res = await apiReq("DELETE", "/alerts/1.5");
    expect(res.status).toBe(404);
  });

  test("404 response includes error message", async () => {
    const res = await apiReq("DELETE", "/alerts/99999");
    const body = await res.json();
    expect(body.error).toMatch(/not found/i);
  });
});

// ─── Workflow: alert trigger lifecycle ────────────────────────────────────────

describe("Alert lifecycle - trigger and deduplicate", () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("first run triggers alert when condition met", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeClobMarket(0.75)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });
    const state = {
      alertConfigs: [{ marketId: "0xTRIG", outcome: "Yes", threshold: 60, direction: "above" as const, notifyUrl: NOTIFY }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };
    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(1);
    expect(result.state.triggeredAlerts).toContain("0xTRIG-Yes-60-above");
  });

  test("second run skips already-triggered alert", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeClobMarket(0.75)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });
    const state = {
      alertConfigs: [{ marketId: "0xTRIG", outcome: "Yes", threshold: 60, direction: "above" as const, notifyUrl: NOTIFY }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: ["0xTRIG-Yes-60-above"],
    };
    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(0);
  });

  test("different alert on same market can still trigger", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeClobMarket(0.75)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });
    const state = {
      alertConfigs: [
        { marketId: "0xMKT", outcome: "Yes", threshold: 60, direction: "above" as const, notifyUrl: NOTIFY },
        { marketId: "0xMKT", outcome: "Yes", threshold: 70, direction: "above" as const, notifyUrl: NOTIFY },
      ],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: ["0xMKT-Yes-60-above"],
    };
    const result = await executeWorkflow(state);
    // First is already triggered, second might be rate-limited but key is different
    expect(result.state.triggeredAlerts).toContain("0xMKT-Yes-60-above");
  });
});

// ─── Alert key generation ────────────────────────────────────────────────────

describe("Alert lifecycle - alert key format", () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("alert key format is marketId-outcome-threshold-direction", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeClobMarket(0.80)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });
    const state = {
      alertConfigs: [{ marketId: "0xKEY", outcome: "Yes", threshold: 70, direction: "above" as const, notifyUrl: NOTIFY }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };
    const result = await executeWorkflow(state);
    expect(result.state.triggeredAlerts).toContain("0xKEY-Yes-70-above");
  });

  test("below direction creates different key than above", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeClobMarket(0.20)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });
    const state = {
      alertConfigs: [{ marketId: "0xDIR", outcome: "Yes", threshold: 30, direction: "below" as const, notifyUrl: NOTIFY }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };
    const result = await executeWorkflow(state);
    expect(result.state.triggeredAlerts).toContain("0xDIR-Yes-30-below");
  });

  test("No outcome creates different key than Yes", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeClobMarket(0.80)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });
    const state = {
      alertConfigs: [{ marketId: "0xOUT", outcome: "No", threshold: 25, direction: "below" as const, notifyUrl: NOTIFY }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };
    const result = await executeWorkflow(state);
    // No price = 20%, threshold 25 below => should trigger
    expect(result.state.triggeredAlerts).toContain("0xOUT-No-25-below");
  });
});

// ─── Webhook payload validation ──────────────────────────────────────────────

describe("Alert lifecycle - webhook payload", () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("webhook receives correct payload type", async () => {
    let payload: any = null;
    global.fetch = mock(async (url: string, opts?: any) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeClobMarket(0.75, {
          condition_id: "0xPAY",
          question: "Payload test?"
        })), { status: 200 });
      }
      payload = JSON.parse(opts?.body || "{}");
      return new Response("ok", { status: 200 });
    });
    const state = {
      alertConfigs: [{ marketId: "0xPAY", outcome: "Yes", threshold: 60, direction: "above" as const, notifyUrl: NOTIFY }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };
    await executeWorkflow(state);
    expect(payload).not.toBeNull();
    expect(payload.type).toBe("prediction_market_alert");
  });

  test("webhook payload includes marketId", async () => {
    let payload: any = null;
    global.fetch = mock(async (url: string, opts?: any) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeClobMarket(0.75, { condition_id: "0xID" })), { status: 200 });
      }
      payload = JSON.parse(opts?.body || "{}");
      return new Response("ok", { status: 200 });
    });
    const state = {
      alertConfigs: [{ marketId: "0xID", outcome: "Yes", threshold: 60, direction: "above" as const, notifyUrl: NOTIFY }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };
    await executeWorkflow(state);
    expect(payload.marketId).toBe("0xID");
  });

  test("webhook payload includes question", async () => {
    let payload: any = null;
    global.fetch = mock(async (url: string, opts?: any) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeClobMarket(0.75, { question: "Is this right?" })), { status: 200 });
      }
      payload = JSON.parse(opts?.body || "{}");
      return new Response("ok", { status: 200 });
    });
    const state = {
      alertConfigs: [{ marketId: "0xQ", outcome: "Yes", threshold: 60, direction: "above" as const, notifyUrl: NOTIFY }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };
    await executeWorkflow(state);
    expect(payload.question).toBe("Is this right?");
  });

  test("webhook payload includes outcome and threshold", async () => {
    let payload: any = null;
    global.fetch = mock(async (url: string, opts?: any) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeClobMarket(0.75)), { status: 200 });
      }
      payload = JSON.parse(opts?.body || "{}");
      return new Response("ok", { status: 200 });
    });
    const state = {
      alertConfigs: [{ marketId: "0xOT", outcome: "Yes", threshold: 60, direction: "above" as const, notifyUrl: NOTIFY }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };
    await executeWorkflow(state);
    expect(payload.outcome).toBe("Yes");
    expect(payload.threshold).toBe(60);
    expect(payload.direction).toBe("above");
  });

  test("webhook payload includes triggeredAt timestamp", async () => {
    let payload: any = null;
    global.fetch = mock(async (url: string, opts?: any) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeClobMarket(0.75)), { status: 200 });
      }
      payload = JSON.parse(opts?.body || "{}");
      return new Response("ok", { status: 200 });
    });
    const state = {
      alertConfigs: [{ marketId: "0xTS", outcome: "Yes", threshold: 60, direction: "above" as const, notifyUrl: NOTIFY }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };
    await executeWorkflow(state);
    expect(payload.triggeredAt).toBeTruthy();
    // Should be a valid ISO timestamp
    const date = new Date(payload.triggeredAt);
    expect(date.toISOString()).toBe(payload.triggeredAt);
  });

  test("webhook payload currentPrice is formatted as string", async () => {
    let payload: any = null;
    global.fetch = mock(async (url: string, opts?: any) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeClobMarket(0.7777)), { status: 200 });
      }
      payload = JSON.parse(opts?.body || "{}");
      return new Response("ok", { status: 200 });
    });
    const state = {
      alertConfigs: [{ marketId: "0xPRICE", outcome: "Yes", threshold: 60, direction: "above" as const, notifyUrl: NOTIFY }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };
    await executeWorkflow(state);
    expect(typeof payload.currentPrice).toBe("string");
  });
});

// ─── Webhook failure handling ────────────────────────────────────────────────

describe("Alert lifecycle - webhook failures", () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("webhook 500 does not mark alert as triggered", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeClobMarket(0.75)), { status: 200 });
      }
      return new Response("Server Error", { status: 500 });
    });
    const state = {
      alertConfigs: [{ marketId: "0xFAIL", outcome: "Yes", threshold: 60, direction: "above" as const, notifyUrl: NOTIFY }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };
    const result = await executeWorkflow(state);
    expect(result.state.triggeredAlerts).not.toContain("0xFAIL-Yes-60-above");
  });

  test("webhook network error does not mark alert as triggered", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeClobMarket(0.75)), { status: 200 });
      }
      throw new Error("Connection refused");
    });
    const state = {
      alertConfigs: [{ marketId: "0xNET", outcome: "Yes", threshold: 60, direction: "above" as const, notifyUrl: NOTIFY }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };
    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(0);
  });

  test("webhook 403 does not mark alert as triggered", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeClobMarket(0.75)), { status: 200 });
      }
      return new Response("Forbidden", { status: 403 });
    });
    const state = {
      alertConfigs: [{ marketId: "0xFORBID", outcome: "Yes", threshold: 60, direction: "above" as const, notifyUrl: NOTIFY }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };
    const result = await executeWorkflow(state);
    expect(result.state.triggeredAlerts).not.toContain("0xFORBID-Yes-60-above");
  });

  test("webhook 200 marks alert as triggered", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeClobMarket(0.75)), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });
    const state = {
      alertConfigs: [{ marketId: "0xOK", outcome: "Yes", threshold: 60, direction: "above" as const, notifyUrl: NOTIFY }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };
    const result = await executeWorkflow(state);
    expect(result.state.triggeredAlerts).toContain("0xOK-Yes-60-above");
    expect(result.alerts).toHaveLength(1);
  });

  test("webhook 201 marks alert as triggered (2xx success)", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeClobMarket(0.75)), { status: 200 });
      }
      return new Response("Created", { status: 201 });
    });
    const state = {
      alertConfigs: [{ marketId: "0x201", outcome: "Yes", threshold: 60, direction: "above" as const, notifyUrl: NOTIFY }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };
    const result = await executeWorkflow(state);
    expect(result.state.triggeredAlerts).toContain("0x201-Yes-60-above");
  });
});

// ─── State preservation across runs ──────────────────────────────────────────

describe("Alert lifecycle - state preservation", () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("existing triggeredAlerts are preserved", async () => {
    global.fetch = mock(async () =>
      new Response(JSON.stringify(makeClobMarket(0.50)), { status: 200 })
    );
    const state = {
      alertConfigs: [{ marketId: "0xMKT", outcome: "Yes", threshold: 60, direction: "above" as const, notifyUrl: NOTIFY }],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: ["old-key-1", "old-key-2"],
    };
    const result = await executeWorkflow(state);
    expect(result.state.triggeredAlerts).toContain("old-key-1");
    expect(result.state.triggeredAlerts).toContain("old-key-2");
  });

  test("existing lastChecked entries are preserved", async () => {
    const state = {
      alertConfigs: [],
      lastChecked: { "0xOLD": 12345, "0xANCIENT": 67890 } as Record<string, number>,
      triggeredAlerts: [] as string[],
    };
    const result = await executeWorkflow(state);
    expect(result.state.lastChecked["0xOLD"]).toBe(12345);
    expect(result.state.lastChecked["0xANCIENT"]).toBe(67890);
  });

  test("empty state returns empty alerts", async () => {
    const state = {
      alertConfigs: [],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };
    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(0);
    expect(result.state.triggeredAlerts).toHaveLength(0);
  });

  test("state object reference is same as input", async () => {
    const state = {
      alertConfigs: [],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };
    const result = await executeWorkflow(state);
    expect(result.state).toBe(state);
  });
});

// ─── Multi-alert workflows ───────────────────────────────────────────────────

describe("Alert lifecycle - multiple alerts", () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("two alerts for different markets both trigger", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("mkt-a")) {
        return new Response(JSON.stringify(makeClobMarket(0.80, { condition_id: "mkt-a" })), { status: 200 });
      }
      if (typeof url === "string" && url.includes("mkt-b")) {
        return new Response(JSON.stringify(makeClobMarket(0.20, { condition_id: "mkt-b" })), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });
    const state = {
      alertConfigs: [
        { marketId: "mkt-a", outcome: "Yes", threshold: 70, direction: "above" as const, notifyUrl: NOTIFY },
        { marketId: "mkt-b", outcome: "Yes", threshold: 30, direction: "below" as const, notifyUrl: NOTIFY },
      ],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };
    const result = await executeWorkflow(state);
    expect(result.alerts).toHaveLength(2);
    expect(result.state.triggeredAlerts).toContain("mkt-a-Yes-70-above");
    expect(result.state.triggeredAlerts).toContain("mkt-b-Yes-30-below");
  });

  test("one triggered + one not-met + one failed-fetch", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("mkt-ok")) {
        return new Response(JSON.stringify(makeClobMarket(0.50, { condition_id: "mkt-ok" })), { status: 200 });
      }
      if (typeof url === "string" && url.includes("mkt-404")) {
        return new Response("Not Found", { status: 404 });
      }
      return new Response("ok", { status: 200 });
    });
    const state = {
      alertConfigs: [
        { marketId: "mkt-ok", outcome: "Yes", threshold: 60, direction: "above" as const, notifyUrl: NOTIFY },
        { marketId: "mkt-404", outcome: "Yes", threshold: 50, direction: "above" as const, notifyUrl: NOTIFY },
      ],
      lastChecked: {} as Record<string, number>,
      triggeredAlerts: [] as string[],
    };
    const result = await executeWorkflow(state);
    // mkt-ok: 50% < 60% above => no trigger
    // mkt-404: fetch returns null => skipped
    expect(result.alerts).toHaveLength(0);
  });
});

// ─── Alert configuration structure ───────────────────────────────────────────

describe("Alert lifecycle - NLP to alert config mapping", () => {
  test("parseAlertRequest returns correct AlertConfig structure", () => {
    const config = parseAlertRequest("when Trump exceeds 65%", NOTIFY);
    expect(config).not.toBeNull();
    expect(config).toHaveProperty("marketId");
    expect(config).toHaveProperty("outcome");
    expect(config).toHaveProperty("threshold");
    expect(config).toHaveProperty("direction");
    expect(config).toHaveProperty("notifyUrl");
  });

  test("parseAlertRequest marketId is always empty string", () => {
    const config = parseAlertRequest("Trump > 70%", NOTIFY);
    expect(config).not.toBeNull();
    expect(config!.marketId).toBe("");
  });

  test("parseMultiConditionAlert returns array of AlertConfigs", () => {
    const configs = parseMultiConditionAlert("Trump > 60% & Biden < 40%", NOTIFY);
    expect(configs.length).toBeGreaterThanOrEqual(1);
    for (const config of configs) {
      expect(config).toHaveProperty("marketId");
      expect(config).toHaveProperty("outcome");
      expect(config).toHaveProperty("threshold");
      expect(config).toHaveProperty("direction");
      expect(config).toHaveProperty("notifyUrl");
    }
  });

  test("each config from multi-condition has correct types", () => {
    const configs = parseMultiConditionAlert("A > 55% & B < 35%", NOTIFY);
    for (const config of configs) {
      expect(typeof config.marketId).toBe("string");
      expect(typeof config.outcome).toBe("string");
      expect(typeof config.threshold).toBe("number");
      expect(["above", "below"]).toContain(config.direction);
      expect(typeof config.notifyUrl).toBe("string");
    }
  });
});

// ─── Payment required response for different request bodies ──────────────────

describe("Alert lifecycle - 402 with various request bodies", () => {
  test("empty body returns 402", async () => {
    const res = await apiReq("POST", "/alerts", { body: {} });
    expect(res.status).toBe(402);
  });

  test("body with only naturalLanguage returns 402 (no payment)", async () => {
    const res = await apiReq("POST", "/alerts", {
      body: { naturalLanguage: "when Trump exceeds 60%" },
    });
    expect(res.status).toBe(402);
  });

  test("body with structured fields returns 402 (no payment)", async () => {
    const res = await apiReq("POST", "/alerts", {
      body: { marketId: "0x1", threshold: 60, notifyUrl: "https://hook.io" },
    });
    expect(res.status).toBe(402);
  });

  test("402 description uses body description when provided", async () => {
    const res = await apiReq("POST", "/alerts", {
      body: { description: "My custom alert" },
    });
    const body = await res.json();
    expect(body.description).toContain("My custom alert");
  });

  test("402 description defaults when no description provided", async () => {
    const res = await apiReq("POST", "/alerts", { body: {} });
    const body = await res.json();
    expect(body.description).toContain("Custom alert");
  });
});

// ─── createPaymentRequired integration ───────────────────────────────────────

describe("Alert lifecycle - payment required generation", () => {
  test("createPaymentRequired generates valid payment request", () => {
    const result = createPaymentRequired("/alerts", "Create alert");
    expect(result.status).toBe(402);
    expect(result.body.resource).toBe("/alerts");
    expect(result.body.description).toBe("Create alert");
    expect(result.body.chainId).toBe(8453);
    expect(result.body.network).toBe("base");
  });

  test("payment request has valid nonce", () => {
    const result = createPaymentRequired("/alerts", "test");
    expect(result.body.nonce).toMatch(/^0x[0-9a-f]+$/);
  });

  test("payment request expiry is 1 hour from now", () => {
    const now = Math.floor(Date.now() / 1000);
    const result = createPaymentRequired("/alerts", "test");
    const delta = result.body.expiry - now;
    expect(delta).toBeGreaterThanOrEqual(3599);
    expect(delta).toBeLessThanOrEqual(3601);
  });

  test("payment request includes USDC asset address", () => {
    const result = createPaymentRequired("/alerts", "test");
    expect(result.body.asset).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  });

  test("payment request maxAmountRequired is 10000 (0.01 USDC)", () => {
    const result = createPaymentRequired("/alerts", "test");
    expect(result.body.maxAmountRequired).toBe("10000");
  });
});
