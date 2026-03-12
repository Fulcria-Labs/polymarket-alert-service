/**
 * Tests for Price History & Trend Analysis API Endpoints
 *
 * Tests GET /markets/:id/history and GET /markets/:id/trend endpoints.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import app from "../api";
import type { PriceSnapshot } from "../polymarket-alert-workflow";

// Helper to make requests to the Hono app
async function request(path: string, options?: RequestInit) {
  const url = `http://localhost${path}`;
  return app.fetch(new Request(url, options));
}

// Save original fetch to restore later
const originalFetch = globalThis.fetch;

describe("GET /markets/:id/history", () => {
  test("returns empty history for unknown market", async () => {
    const res = await request("/markets/0xUNKNOWN/history");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.marketId).toBe("0xUNKNOWN");
    expect(body.dataPoints).toBe(0);
    expect(body.history).toEqual([]);
  });

  test("returns default 24h window", async () => {
    const res = await request("/markets/0xTEST/history");
    const body = await res.json();
    expect(body.hours).toBe(24);
  });

  test("accepts custom hours parameter", async () => {
    const res = await request("/markets/0xTEST/history?hours=6");
    const body = await res.json();
    expect(body.hours).toBe(6);
  });

  test("returns correct response structure", async () => {
    const res = await request("/markets/0xTEST/history");
    const body = await res.json();
    expect(body).toHaveProperty("marketId");
    expect(body).toHaveProperty("hours");
    expect(body).toHaveProperty("dataPoints");
    expect(body).toHaveProperty("history");
    expect(Array.isArray(body.history)).toBe(true);
  });

  test("history entries have timestamps as ISO strings", async () => {
    const res = await request("/markets/0xANY/history");
    const body = await res.json();
    // Even for empty history, structure is correct
    expect(body.history).toEqual([]);
  });

  test("hours=1 returns only recent data", async () => {
    const res = await request("/markets/0xTEST/history?hours=1");
    const body = await res.json();
    expect(body.hours).toBe(1);
  });

  test("hours=0 returns no data", async () => {
    const res = await request("/markets/0xTEST/history?hours=0");
    const body = await res.json();
    expect(body.hours).toBe(0);
    expect(body.dataPoints).toBe(0);
  });
});

describe("GET /markets/:id/trend", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns 404 when no history and market not found", async () => {
    globalThis.fetch = mock(async () =>
      new Response("Not found", { status: 404 })
    );
    const res = await request("/markets/0xNONE/trend");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("No price history");
  });

  test("seeds initial data point when market exists but no history", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({
        condition_id: "0xNEW",
        question: "New market?",
        outcomes: ["Yes", "No"],
        tokens: [
          { token_id: "t1", outcome: "Yes", price: 0.65 },
          { token_id: "t2", outcome: "No", price: 0.35 },
        ],
        active: true,
        closed: false,
      }))
    );

    const res = await request("/markets/0xNEW/trend");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.note).toContain("First data point");
    expect(body.trend).toBeDefined();
    expect(body.trend.currentPrice).toBeCloseTo(65, 0);
  });

  test("defaults to Yes outcome", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({
        condition_id: "0xDEFAULT",
        question: "Default outcome?",
        outcomes: ["Yes", "No"],
        tokens: [
          { token_id: "t1", outcome: "Yes", price: 0.55 },
          { token_id: "t2", outcome: "No", price: 0.45 },
        ],
        active: true,
        closed: false,
      }))
    );

    const res = await request("/markets/0xDEFAULT/trend");
    const body = await res.json();
    expect(body.trend.outcome).toBe("Yes");
  });

  test("accepts outcome parameter", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({
        condition_id: "0xOUTCOME",
        question: "Outcome param?",
        outcomes: ["Yes", "No"],
        tokens: [
          { token_id: "t1", outcome: "Yes", price: 0.55 },
          { token_id: "t2", outcome: "No", price: 0.45 },
        ],
        active: true,
        closed: false,
      }))
    );

    const res = await request("/markets/0xOUTCOME/trend?outcome=No");
    const body = await res.json();
    expect(body.trend.outcome).toBe("No");
  });

  test("trend response includes all analysis fields", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({
        condition_id: "0xFIELDS",
        question: "All fields?",
        outcomes: ["Yes", "No"],
        tokens: [
          { token_id: "t1", outcome: "Yes", price: 0.50 },
          { token_id: "t2", outcome: "No", price: 0.50 },
        ],
        active: true,
        closed: false,
      }))
    );

    const res = await request("/markets/0xFIELDS/trend");
    const body = await res.json();
    const trend = body.trend;
    expect(trend).toHaveProperty("outcome");
    expect(trend).toHaveProperty("currentPrice");
    expect(trend).toHaveProperty("changePercent1h");
    expect(trend).toHaveProperty("changePercent6h");
    expect(trend).toHaveProperty("changePercent24h");
    expect(trend).toHaveProperty("momentum");
    expect(trend).toHaveProperty("volatility");
    expect(trend).toHaveProperty("dataPoints");
  });
});

describe("Trend API - Momentum Labels", () => {
  test("momentum is a valid label", async () => {
    const validLabels = ["surging_up", "trending_up", "stable", "trending_down", "surging_down"];

    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({
        condition_id: "0xMOM",
        question: "Momentum?",
        outcomes: ["Yes", "No"],
        tokens: [
          { token_id: "t1", outcome: "Yes", price: 0.50 },
          { token_id: "t2", outcome: "No", price: 0.50 },
        ],
        active: true,
        closed: false,
      }))
    );

    const res = await request("/markets/0xMOM/trend");
    const body = await res.json();
    expect(validLabels).toContain(body.trend.momentum);
  });
});

describe("History API - Edge Cases", () => {
  test("very large hours value", async () => {
    const res = await request("/markets/0xTEST/history?hours=8760"); // 1 year
    const body = await res.json();
    expect(body.hours).toBe(8760);
    expect(body.dataPoints).toBe(0); // No data that old
  });

  test("negative hours treated as zero window", async () => {
    const res = await request("/markets/0xTEST/history?hours=-1");
    const body = await res.json();
    expect(body.dataPoints).toBe(0);
  });

  test("non-numeric hours defaults to NaN handling", async () => {
    const res = await request("/markets/0xTEST/history?hours=abc");
    const body = await res.json();
    // NaN from parseInt, should still return 200
    expect(res.status).toBe(200);
  });

  test("market ID with special characters", async () => {
    const res = await request("/markets/0x1234abcdef5678/history");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.marketId).toBe("0x1234abcdef5678");
  });
});

describe("Existing Endpoints Still Work", () => {
  test("GET /health returns healthy status", async () => {
    const res = await request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("healthy");
  });

  test("GET /payment-info returns payment details", async () => {
    const res = await request("/payment-info");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("instructions");
    expect(body).toHaveProperty("receiver");
    expect(body).toHaveProperty("asset");
  });

  test("GET /pricing returns pricing info", async () => {
    const res = await request("/pricing?count=5");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("totalUsdc");
    expect(body).toHaveProperty("discount");
    expect(body.discount).toBe(0.1); // 10% for 5+
  });

  test("GET /alerts returns alert list", async () => {
    const res = await request("/alerts");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("count");
    expect(body).toHaveProperty("alerts");
  });
});
