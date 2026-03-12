/**
 * Tests for Trend-Based Alert Execution
 *
 * Tests that the CRE workflow correctly detects and triggers trend-based alerts
 * alongside traditional threshold alerts.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { executeWorkflow, recordPriceSnapshot, analyzeTrend } from "../polymarket-alert-workflow";
import type { WorkflowState, AlertConfig, PriceSnapshot } from "../polymarket-alert-workflow";

const originalFetch = globalThis.fetch;

function createState(overrides?: Partial<WorkflowState>): WorkflowState {
  return {
    alertConfigs: [],
    lastChecked: {},
    triggeredAlerts: [],
    priceHistory: {},
    ...overrides,
  };
}

function mockMarket(yesPrice: number) {
  return {
    condition_id: "0xMARKET1",
    question: "Will it happen?",
    outcomes: ["Yes", "No"],
    tokens: [
      { token_id: "t1", outcome: "Yes", price: yesPrice / 100 },
      { token_id: "t2", outcome: "No", price: (100 - yesPrice) / 100 },
    ],
    active: true,
    closed: false,
  };
}

function snap(timestamp: number, yesPrice: number): PriceSnapshot {
  return {
    timestamp,
    prices: { Yes: yesPrice, No: 100 - yesPrice },
  };
}

describe("Trend Alert - Workflow Execution", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("trend alert triggers when upward trend detected", async () => {
    const now = Date.now();
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify(mockMarket(65)))
    );

    // Pre-seed price history showing upward trend
    const priceHistory: Record<string, PriceSnapshot[]> = {
      "0xMARKET1": [
        snap(now - 3600000, 50), // 1h ago: 50%
        snap(now - 2700000, 53),
        snap(now - 1800000, 56),
        snap(now - 900000, 60),
        snap(now - 100, 65),     // now: 65% (+15% in 1h)
      ],
    };

    const state = createState({
      alertConfigs: [{
        marketId: "0xMARKET1",
        outcome: "Yes",
        threshold: 0,
        direction: "above",
        notifyUrl: "https://example.com/webhook",
        type: "trend",
        trendDirection: "up",
        trendMinChange: 5,
        trendWindow: 3600000,
      }],
      priceHistory,
    });

    const result = await executeWorkflow(state);
    expect(result.alerts.length).toBe(1);
    expect(result.alerts[0]).toContain("Trend alert");
    expect(result.alerts[0]).toContain("up");
  });

  test("trend alert does not trigger when change is below threshold", async () => {
    const now = Date.now();
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify(mockMarket(52)))
    );

    const priceHistory: Record<string, PriceSnapshot[]> = {
      "0xMARKET1": [
        snap(now - 3600000, 50), // Only +2% in 1h
        snap(now - 100, 52),
      ],
    };

    const state = createState({
      alertConfigs: [{
        marketId: "0xMARKET1",
        outcome: "Yes",
        threshold: 0,
        direction: "above",
        notifyUrl: "https://example.com/webhook",
        type: "trend",
        trendDirection: "up",
        trendMinChange: 5, // Needs 5% change
        trendWindow: 3600000,
      }],
      priceHistory,
    });

    const result = await executeWorkflow(state);
    expect(result.alerts.length).toBe(0);
  });

  test("downward trend alert triggers on price drop", async () => {
    const now = Date.now();
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify(mockMarket(40)))
    );

    const priceHistory: Record<string, PriceSnapshot[]> = {
      "0xMARKET1": [
        snap(now - 3600000, 55), // 1h ago: 55%
        snap(now - 100, 40),     // now: 40% (-15%)
      ],
    };

    const state = createState({
      alertConfigs: [{
        marketId: "0xMARKET1",
        outcome: "Yes",
        threshold: 0,
        direction: "above",
        notifyUrl: "https://example.com/webhook",
        type: "trend",
        trendDirection: "down",
        trendMinChange: 10,
        trendWindow: 3600000,
      }],
      priceHistory,
    });

    const result = await executeWorkflow(state);
    expect(result.alerts.length).toBe(1);
    expect(result.alerts[0]).toContain("Trend alert");
    expect(result.alerts[0]).toContain("down");
  });

  test("trend alert not re-triggered after first trigger", async () => {
    const now = Date.now();
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify(mockMarket(65)))
    );

    const priceHistory: Record<string, PriceSnapshot[]> = {
      "0xMARKET1": [
        snap(now - 3600000, 50),
        snap(now - 100, 65),
      ],
    };

    const state = createState({
      alertConfigs: [{
        marketId: "0xMARKET1",
        outcome: "Yes",
        threshold: 0,
        direction: "above",
        notifyUrl: "https://example.com/webhook",
        type: "trend",
        trendDirection: "up",
        trendMinChange: 5,
      }],
      triggeredAlerts: ["0xMARKET1-Yes-0-above"], // Already triggered
      priceHistory,
    });

    const result = await executeWorkflow(state);
    expect(result.alerts.length).toBe(0);
  });

  test("threshold and trend alerts can coexist on different markets", async () => {
    const now = Date.now();
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes("0xMARKET_A")) {
        return new Response(JSON.stringify({
          ...mockMarket(65),
          condition_id: "0xMARKET_A",
          question: "Market A?",
        }));
      }
      return new Response(JSON.stringify({
        ...mockMarket(65),
        condition_id: "0xMARKET_B",
        question: "Market B?",
      }));
    });

    const priceHistory: Record<string, PriceSnapshot[]> = {
      "0xMARKET_B": [
        snap(now - 3600000, 50),
        snap(now - 100, 65),
      ],
    };

    const state = createState({
      alertConfigs: [
        {
          marketId: "0xMARKET_A",
          outcome: "Yes",
          threshold: 60,
          direction: "above",
          notifyUrl: "https://example.com/webhook",
          type: "threshold",
        },
        {
          marketId: "0xMARKET_B",
          outcome: "Yes",
          threshold: 0,
          direction: "above",
          notifyUrl: "https://example.com/webhook2",
          type: "trend",
          trendDirection: "up",
          trendMinChange: 5,
        },
      ],
      priceHistory,
    });

    const result = await executeWorkflow(state);
    // Both should trigger (different markets, no rate limit conflict)
    expect(result.alerts.length).toBe(2);
  });

  test("trend alert with insufficient history does not trigger", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify(mockMarket(65)))
    );

    // Only 1 snapshot - can't detect trend
    const state = createState({
      alertConfigs: [{
        marketId: "0xMARKET1",
        outcome: "Yes",
        threshold: 0,
        direction: "above",
        notifyUrl: "https://example.com/webhook",
        type: "trend",
        trendDirection: "up",
        trendMinChange: 5,
      }],
      priceHistory: {
        "0xMARKET1": [snap(Date.now() - 100, 65)],
      },
    });

    const result = await executeWorkflow(state);
    expect(result.alerts.length).toBe(0);
  });

  test("workflow records price snapshot on each execution", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify(mockMarket(55)))
    );

    const state = createState({
      alertConfigs: [{
        marketId: "0xMARKET1",
        outcome: "Yes",
        threshold: 90, // Won't trigger
        direction: "above",
        notifyUrl: "https://example.com/webhook",
      }],
    });

    await executeWorkflow(state);
    expect(state.priceHistory["0xMARKET1"]).toBeDefined();
    expect(state.priceHistory["0xMARKET1"].length).toBeGreaterThanOrEqual(1);
  });

  test("default alert type is threshold", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify(mockMarket(65)))
    );

    const state = createState({
      alertConfigs: [{
        marketId: "0xMARKET1",
        outcome: "Yes",
        threshold: 60,
        direction: "above",
        notifyUrl: "https://example.com/webhook",
        // No type specified - should default to threshold
      }],
    });

    const result = await executeWorkflow(state);
    expect(result.alerts.length).toBe(1);
    expect(result.alerts[0]).toContain("Alert triggered"); // Threshold format
  });

  test("trend alert with 6h window uses 6h change", async () => {
    const now = Date.now();
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify(mockMarket(65)))
    );

    const priceHistory: Record<string, PriceSnapshot[]> = {
      "0xMARKET1": [
        snap(now - 21600000, 40), // 6h ago: 40%
        snap(now - 3600000, 63),  // 1h ago: 63% (only +2% in 1h)
        snap(now - 100, 65),      // now: 65% (+25% in 6h)
      ],
    };

    const state = createState({
      alertConfigs: [{
        marketId: "0xMARKET1",
        outcome: "Yes",
        threshold: 0,
        direction: "above",
        notifyUrl: "https://example.com/webhook",
        type: "trend",
        trendDirection: "up",
        trendMinChange: 20,
        trendWindow: 21600000, // 6h window
      }],
      priceHistory,
    });

    const result = await executeWorkflow(state);
    expect(result.alerts.length).toBe(1);
  });

  test("trend alert with 24h window uses 24h change", async () => {
    const now = Date.now();
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify(mockMarket(70)))
    );

    const priceHistory: Record<string, PriceSnapshot[]> = {
      "0xMARKET1": [
        snap(now - 86400000, 30), // 24h ago: 30%
        snap(now - 21600000, 60), // 6h ago: 60%
        snap(now - 3600000, 68),  // 1h ago: 68%
        snap(now - 100, 70),      // now: 70% (+40% in 24h)
      ],
    };

    const state = createState({
      alertConfigs: [{
        marketId: "0xMARKET1",
        outcome: "Yes",
        threshold: 0,
        direction: "above",
        notifyUrl: "https://example.com/webhook",
        type: "trend",
        trendDirection: "up",
        trendMinChange: 30,
        trendWindow: 86400000, // 24h window
      }],
      priceHistory,
    });

    const result = await executeWorkflow(state);
    expect(result.alerts.length).toBe(1);
  });

  test("rate limiting still applies to trend alerts", async () => {
    const now = Date.now();
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify(mockMarket(65)))
    );

    const state = createState({
      alertConfigs: [{
        marketId: "0xMARKET1",
        outcome: "Yes",
        threshold: 0,
        direction: "above",
        notifyUrl: "https://example.com/webhook",
        type: "trend",
        trendDirection: "up",
        trendMinChange: 5,
      }],
      lastChecked: { "0xMARKET1": now - 30000 }, // Checked 30s ago (< 60s)
      priceHistory: {
        "0xMARKET1": [snap(now - 3600000, 50), snap(now - 100, 65)],
      },
    });

    const result = await executeWorkflow(state);
    expect(result.alerts.length).toBe(0); // Rate limited
  });

  test("inactive market skipped for trend alerts", async () => {
    const now = Date.now();
    const market = mockMarket(65);
    market.active = false;

    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify(market))
    );

    const state = createState({
      alertConfigs: [{
        marketId: "0xMARKET1",
        outcome: "Yes",
        threshold: 0,
        direction: "above",
        notifyUrl: "https://example.com/webhook",
        type: "trend",
        trendDirection: "up",
        trendMinChange: 5,
      }],
      priceHistory: {
        "0xMARKET1": [snap(now - 3600000, 50), snap(now - 100, 65)],
      },
    });

    const result = await executeWorkflow(state);
    expect(result.alerts.length).toBe(0);
  });

  test("closed market skipped for trend alerts", async () => {
    const now = Date.now();
    const market = mockMarket(65);
    market.closed = true;

    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify(market))
    );

    const state = createState({
      alertConfigs: [{
        marketId: "0xMARKET1",
        outcome: "Yes",
        threshold: 0,
        direction: "above",
        notifyUrl: "https://example.com/webhook",
        type: "trend",
        trendDirection: "up",
        trendMinChange: 5,
      }],
      priceHistory: {
        "0xMARKET1": [snap(now - 3600000, 50), snap(now - 100, 65)],
      },
    });

    const result = await executeWorkflow(state);
    expect(result.alerts.length).toBe(0);
  });

  test("priceHistory initialized if missing from state", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify(mockMarket(55)))
    );

    const state: any = {
      alertConfigs: [{
        marketId: "0xMARKET1",
        outcome: "Yes",
        threshold: 90,
        direction: "above",
        notifyUrl: "https://example.com/webhook",
      }],
      lastChecked: {},
      triggeredAlerts: [],
      // No priceHistory field
    };

    await executeWorkflow(state);
    expect(state.priceHistory).toBeDefined();
  });

  test("trend alert default window is 1 hour", async () => {
    const now = Date.now();
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify(mockMarket(60)))
    );

    // 1h change: +10%, 6h change: +2%
    const priceHistory: Record<string, PriceSnapshot[]> = {
      "0xMARKET1": [
        snap(now - 21600000, 58), // 6h ago: 58%
        snap(now - 3600000, 50),  // 1h ago: 50%
        snap(now - 100, 60),      // now: 60%
      ],
    };

    const state = createState({
      alertConfigs: [{
        marketId: "0xMARKET1",
        outcome: "Yes",
        threshold: 0,
        direction: "above",
        notifyUrl: "https://example.com/webhook",
        type: "trend",
        trendDirection: "up",
        trendMinChange: 8, // 8% threshold
        // No trendWindow - defaults to 1h
      }],
      priceHistory,
    });

    const result = await executeWorkflow(state);
    // 1h change is +10%, which is > 8% threshold
    expect(result.alerts.length).toBe(1);
  });

  test("trend alert default minChange is 5%", async () => {
    const now = Date.now();
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify(mockMarket(56)))
    );

    const priceHistory: Record<string, PriceSnapshot[]> = {
      "0xMARKET1": [
        snap(now - 3600000, 50),
        snap(now - 100, 56), // +6% in 1h
      ],
    };

    const state = createState({
      alertConfigs: [{
        marketId: "0xMARKET1",
        outcome: "Yes",
        threshold: 0,
        direction: "above",
        notifyUrl: "https://example.com/webhook",
        type: "trend",
        trendDirection: "up",
        // No trendMinChange - defaults to 5%
      }],
      priceHistory,
    });

    const result = await executeWorkflow(state);
    expect(result.alerts.length).toBe(1);
  });

  test("multiple trend alerts for different markets", async () => {
    const now = Date.now();
    let callCount = 0;
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      callCount++;
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes("0xMARKET1")) {
        return new Response(JSON.stringify({
          ...mockMarket(65),
          condition_id: "0xMARKET1",
        }));
      } else if (urlStr.includes("0xMARKET2")) {
        return new Response(JSON.stringify({
          ...mockMarket(30),
          condition_id: "0xMARKET2",
        }));
      }
      return new Response(JSON.stringify(mockMarket(50)));
    });

    const priceHistory: Record<string, PriceSnapshot[]> = {
      "0xMARKET1": [snap(now - 3600000, 50), snap(now - 100, 65)],
      "0xMARKET2": [snap(now - 3600000, 45), snap(now - 100, 30)],
    };

    const state = createState({
      alertConfigs: [
        {
          marketId: "0xMARKET1",
          outcome: "Yes",
          threshold: 0,
          direction: "above",
          notifyUrl: "https://example.com/webhook",
          type: "trend",
          trendDirection: "up",
          trendMinChange: 10,
        },
        {
          marketId: "0xMARKET2",
          outcome: "Yes",
          threshold: 0,
          direction: "above",
          notifyUrl: "https://example.com/webhook",
          type: "trend",
          trendDirection: "down",
          trendMinChange: 10,
        },
      ],
      priceHistory,
    });

    const result = await executeWorkflow(state);
    expect(result.alerts.length).toBe(2);
  });
});

describe("Trend Alert Message Format", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("trend alert message includes direction and min change", async () => {
    const now = Date.now();
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify(mockMarket(65)))
    );

    const state = createState({
      alertConfigs: [{
        marketId: "0xMARKET1",
        outcome: "Yes",
        threshold: 0,
        direction: "above",
        notifyUrl: "https://example.com/webhook",
        type: "trend",
        trendDirection: "up",
        trendMinChange: 10,
      }],
      priceHistory: {
        "0xMARKET1": [
          snap(now - 3600000, 50),
          snap(now - 100, 65),
        ],
      },
    });

    const result = await executeWorkflow(state);
    expect(result.alerts[0]).toContain("Trend alert");
    expect(result.alerts[0]).toContain("Will it happen?");
    expect(result.alerts[0]).toContain("up");
    expect(result.alerts[0]).toContain("10");
  });

  test("threshold alert message has standard format", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify(mockMarket(65)))
    );

    const state = createState({
      alertConfigs: [{
        marketId: "0xMARKET1",
        outcome: "Yes",
        threshold: 60,
        direction: "above",
        notifyUrl: "https://example.com/webhook",
        type: "threshold",
      }],
    });

    const result = await executeWorkflow(state);
    expect(result.alerts[0]).toContain("Alert triggered");
    expect(result.alerts[0]).toContain("65.0%");
  });
});
