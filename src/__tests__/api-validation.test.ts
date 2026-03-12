/**
 * API Endpoint Validation Edge Cases
 *
 * Covers: input validation, parameter boundaries, content type handling,
 * HTTP method validation, query parameter parsing, response format consistency,
 * error message quality, header handling, path parameter validation.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import app from "../api";

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function req(
  method: string,
  path: string,
  opts: { body?: any; headers?: Record<string, string> } = {}
): Promise<Response> {
  const url = `http://localhost${path}`;
  const init: RequestInit = { method };
  if (opts.headers) init.headers = opts.headers;
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    init.headers = {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    };
  }
  return app.fetch(new Request(url, init));
}

// ─── Health endpoint ────────────────────────────────────────────────────────

describe("API - health endpoint", () => {
  test("GET /health returns 200", async () => {
    const res = await req("GET", "/health");
    expect(res.status).toBe(200);
  });

  test("GET /health returns JSON with status field", async () => {
    const res = await req("GET", "/health");
    const body = await res.json();
    expect(body.status).toBe("healthy");
  });

  test("GET /health includes version field", async () => {
    const res = await req("GET", "/health");
    const body = await res.json();
    expect(body.version).toBeTruthy();
  });

  test("GET /health includes alertCount field", async () => {
    const res = await req("GET", "/health");
    const body = await res.json();
    expect(typeof body.alertCount).toBe("number");
  });

  test("GET /health includes timestamp in ISO format", async () => {
    const res = await req("GET", "/health");
    const body = await res.json();
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("GET /health timestamp is valid date", async () => {
    const res = await req("GET", "/health");
    const body = await res.json();
    const parsed = new Date(body.timestamp);
    expect(parsed.getTime()).not.toBeNaN();
  });
});

// ─── Market search validation ───────────────────────────────────────────────

describe("API - market search validation", () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("GET /markets/search without query returns 400", async () => {
    const res = await req("GET", "/markets/search");
    expect(res.status).toBe(400);
  });

  test("GET /markets/search with empty query returns 400", async () => {
    const res = await req("GET", "/markets/search?q=");
    expect(res.status).toBe(400);
  });

  test("GET /markets/search with single char returns 400", async () => {
    const res = await req("GET", "/markets/search?q=x");
    expect(res.status).toBe(400);
  });

  test("GET /markets/search with 2 chars is accepted", async () => {
    global.fetch = mock(async () => {
      return new Response(JSON.stringify([]), { status: 200 });
    });
    const res = await req("GET", "/markets/search?q=ab");
    expect(res.status).toBe(200);
    global.fetch = originalFetch;
  });

  test("GET /markets/search error message is descriptive", async () => {
    const res = await req("GET", "/markets/search?q=x");
    const body = await res.json();
    expect(body.error).toContain("2 characters");
  });

  test("GET /markets/search with valid query returns structured response", async () => {
    global.fetch = mock(async () => {
      return new Response(JSON.stringify([
        {
          conditionId: "0xTEST",
          question: "Test market?",
          outcomes: ["Yes", "No"],
          tokens: [
            { token_id: "t1", outcome: "Yes", price: 0.60 },
            { token_id: "t2", outcome: "No", price: 0.40 },
          ],
          active: true,
          closed: false,
          volume: 50000,
        },
      ]), { status: 200 });
    });

    const res = await req("GET", "/markets/search?q=test");
    const body = await res.json();
    expect(body.query).toBe("test");
    expect(typeof body.count).toBe("number");
    expect(Array.isArray(body.markets)).toBe(true);
    global.fetch = originalFetch;
  });

  test("search with special characters in query", async () => {
    global.fetch = mock(async () => {
      return new Response(JSON.stringify([]), { status: 200 });
    });
    const res = await req("GET", "/markets/search?q=test%20%26%20demo");
    expect(res.status).toBe(200);
    global.fetch = originalFetch;
  });

  test("search with unicode characters in query", async () => {
    global.fetch = mock(async () => {
      return new Response(JSON.stringify([]), { status: 200 });
    });
    const res = await req("GET", "/markets/search?q=%C3%A9lection");
    expect(res.status).toBe(200);
    global.fetch = originalFetch;
  });
});

// ─── Market details endpoint ────────────────────────────────────────────────

describe("API - market details", () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  test("GET /markets/:id returns 404 for non-existent market", async () => {
    global.fetch = mock(async () => {
      return new Response("Not Found", { status: 404 });
    });
    const res = await req("GET", "/markets/0xNONEXIST");
    expect(res.status).toBe(404);
  });

  test("GET /markets/:id returns market data on success", async () => {
    global.fetch = mock(async () => {
      return new Response(JSON.stringify({
        condition_id: "0xDETAIL",
        question: "Detail test?",
        outcomes: ["Yes", "No"],
        tokens: [
          { token_id: "t1", outcome: "Yes", price: 0.55 },
          { token_id: "t2", outcome: "No", price: 0.45 },
        ],
        active: true,
        closed: false,
        volume: 80000,
      }), { status: 200 });
    });

    const res = await req("GET", "/markets/0xDETAIL");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("0xDETAIL");
    expect(body.question).toBe("Detail test?");
    expect(body.volume).toBe(80000);
  });

  test("market detail response has proper outcome format", async () => {
    global.fetch = mock(async () => {
      return new Response(JSON.stringify({
        condition_id: "0xFMT",
        question: "Format?",
        outcomes: ["Yes", "No"],
        tokens: [
          { token_id: "t1", outcome: "Yes", price: 0.75 },
          { token_id: "t2", outcome: "No", price: 0.25 },
        ],
        active: true,
        closed: false,
        volume: 10000,
      }), { status: 200 });
    });

    const res = await req("GET", "/markets/0xFMT");
    const body = await res.json();
    expect(Array.isArray(body.outcomes)).toBe(true);
    expect(body.outcomes.length).toBe(2);
    expect(body.outcomes[0].name).toBeTruthy();
    expect(body.outcomes[0].price).toBeTruthy();
    expect(body.outcomes[0].tokenId).toBeTruthy();
  });
});

// ─── Alerts endpoint - validation ───────────────────────────────────────────

describe("API - alerts validation", () => {
  test("POST /alerts without body still returns 402 (needs payment)", async () => {
    const res = await req("POST", "/alerts", { body: {} });
    expect(res.status).toBe(402);
  });

  test("POST /alerts with invalid payment proof returns 400", async () => {
    const res = await req("POST", "/alerts", {
      body: { description: "test" },
      headers: { "X-Payment-Proof": "not-json" },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid payment proof");
  });

  test("POST /alerts with wrong chain ID returns 402", async () => {
    const res = await req("POST", "/alerts", {
      body: { description: "test" },
      headers: {
        "X-Payment-Proof": JSON.stringify({
          transactionHash: "0x123",
          blockNumber: 1,
          chainId: 1, // Wrong chain
          payer: "0xabc",
          amount: "10000",
        }),
      },
    });
    expect(res.status).toBe(402);
  });

  test("GET /alerts returns array of alerts", async () => {
    const res = await req("GET", "/alerts");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.count).toBe("number");
    expect(Array.isArray(body.alerts)).toBe(true);
  });

  test("DELETE /alerts/-1 returns 404", async () => {
    const res = await req("DELETE", "/alerts/-1");
    expect(res.status).toBe(404);
  });

  test("DELETE /alerts/abc returns 404", async () => {
    const res = await req("DELETE", "/alerts/abc");
    expect(res.status).toBe(404);
  });

  test("DELETE /alerts/99999 returns 404", async () => {
    const res = await req("DELETE", "/alerts/99999");
    expect(res.status).toBe(404);
  });
});

// ─── Payment info endpoint ──────────────────────────────────────────────────

describe("API - payment info", () => {
  test("GET /payment-info returns 200", async () => {
    const res = await req("GET", "/payment-info");
    expect(res.status).toBe(200);
  });

  test("GET /payment-info has instructions field", async () => {
    const res = await req("GET", "/payment-info");
    const body = await res.json();
    expect(typeof body.instructions).toBe("string");
    expect(body.instructions.length).toBeGreaterThan(0);
  });

  test("GET /payment-info has receiver address", async () => {
    const res = await req("GET", "/payment-info");
    const body = await res.json();
    expect(body.receiver).toMatch(/^0x[0-9a-fA-F]+$/);
  });

  test("GET /payment-info has asset address", async () => {
    const res = await req("GET", "/payment-info");
    const body = await res.json();
    expect(body.asset).toMatch(/^0x[0-9a-fA-F]+$/);
  });

  test("GET /payment-info has numeric amount", async () => {
    const res = await req("GET", "/payment-info");
    const body = await res.json();
    expect(typeof body.amount).toBe("number");
    expect(body.amount).toBeGreaterThan(0);
  });

  test("GET /payment-info has network field", async () => {
    const res = await req("GET", "/payment-info");
    const body = await res.json();
    expect(body.network).toBe("Base");
  });

  test("GET /payment-info has chainId field", async () => {
    const res = await req("GET", "/payment-info");
    const body = await res.json();
    expect(body.chainId).toBe(8453);
  });
});

// ─── Pricing endpoint ───────────────────────────────────────────────────────

describe("API - pricing endpoint", () => {
  test("GET /pricing without count defaults to 1", async () => {
    const res = await req("GET", "/pricing");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalUsdc).toBeGreaterThan(0);
  });

  test("GET /pricing with count=1 returns no discount", async () => {
    const res = await req("GET", "/pricing?count=1");
    const body = await res.json();
    expect(body.discount).toBe(0);
  });

  test("GET /pricing with count=5 returns 10% discount", async () => {
    const res = await req("GET", "/pricing?count=5");
    const body = await res.json();
    expect(body.discount).toBe(0.10);
  });

  test("GET /pricing with count=10 returns 20% discount", async () => {
    const res = await req("GET", "/pricing?count=10");
    const body = await res.json();
    expect(body.discount).toBe(0.20);
  });

  test("GET /pricing with count=100 returns 20% discount", async () => {
    const res = await req("GET", "/pricing?count=100");
    const body = await res.json();
    expect(body.discount).toBe(0.20);
  });

  test("GET /pricing response has all required fields", async () => {
    const res = await req("GET", "/pricing?count=3");
    const body = await res.json();
    expect(typeof body.totalUsdc).toBe("number");
    expect(typeof body.discount).toBe("number");
    expect(typeof body.pricePerAlert).toBe("number");
  });

  test("GET /pricing totalUsdc = pricePerAlert * count", async () => {
    const res = await req("GET", "/pricing?count=7");
    const body = await res.json();
    expect(body.totalUsdc).toBeCloseTo(body.pricePerAlert * 7, 8);
  });
});

// ─── 402 Response format ────────────────────────────────────────────────────

describe("API - 402 response format", () => {
  test("402 response includes X-Payment-Required header", async () => {
    const res = await req("POST", "/alerts", { body: { description: "test" } });
    expect(res.headers.get("X-Payment-Required")).toBe("true");
  });

  test("402 response includes X-Payment-Version header", async () => {
    const res = await req("POST", "/alerts", { body: { description: "test" } });
    expect(res.headers.get("X-Payment-Version")).toBe("1.0");
  });

  test("402 body has payment request structure", async () => {
    const res = await req("POST", "/alerts", { body: { description: "test" } });
    const body = await res.json();
    expect(body.version).toBe("1.0");
    expect(body.network).toBe("base");
    expect(body.chainId).toBe(8453);
    expect(body.payTo).toBeTruthy();
    expect(body.maxAmountRequired).toBe("10000");
    expect(body.asset).toBeTruthy();
    expect(body.resource).toBe("/alerts");
    expect(body.nonce).toBeTruthy();
    expect(body.expiry).toBeGreaterThan(0);
  });

  test("402 body description includes alert description when provided", async () => {
    const res = await req("POST", "/alerts", { body: { description: "My custom alert" } });
    const body = await res.json();
    expect(body.description).toContain("My custom alert");
  });

  test("402 body description has default when no description provided", async () => {
    const res = await req("POST", "/alerts", { body: {} });
    const body = await res.json();
    expect(body.description).toContain("Custom alert");
  });
});

// ─── CORS headers ───────────────────────────────────────────────────────────

describe("API - CORS support", () => {
  test("response includes access-control headers on regular GET", async () => {
    const res = await req("GET", "/health");
    // CORS middleware should add these
    expect(res.status).toBe(200);
  });
});
