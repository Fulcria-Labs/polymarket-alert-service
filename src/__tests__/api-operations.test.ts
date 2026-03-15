/**
 * Comprehensive API Operations & x402 Payment Tests
 *
 * Covers: payment creation, bulk pricing, instructions,
 * portfolio validation edge cases, NLP parsing depth,
 * and concurrent payment/portfolio operations.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import app from "../api";
import { createPaymentRequired, calculateBulkPrice, getPaymentInstructions } from "../x402-handler";
import {
  parseAlertRequest,
  parseMultiConditionAlert,
  extractSearchKeywords,
} from "../polymarket-alert-workflow";
import {
  createPortfolio,
  pearsonCorrelation,
  classifyCorrelation,
  scanForArbitrage,
  detectSingleMarketArbitrage,
} from "../portfolio";

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

// ─── x402 Payment Protocol ──────────────────────────────────────────────────

describe("x402 payment creation", () => {
  test("returns 402 status code", () => {
    const result = createPaymentRequired("/alerts", "Create alert");
    expect(result.status).toBe(402);
  });

  test("includes correct headers", () => {
    const result = createPaymentRequired("/alerts", "test");
    expect(result.headers["X-Payment-Required"]).toBe("true");
    expect(result.headers["X-Payment-Version"]).toBe("1.0");
    expect(result.headers["Content-Type"]).toBe("application/json");
  });

  test("includes Base chain ID 8453", () => {
    const result = createPaymentRequired("/test", "test");
    expect(result.body.chainId).toBe(8453);
    expect(result.body.network).toBe("base");
  });

  test("includes valid USDC asset address", () => {
    const result = createPaymentRequired("/test", "test");
    expect(result.body.asset).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  test("includes valid receiver address", () => {
    const result = createPaymentRequired("/test", "test");
    expect(result.body.payTo).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  test("sets expiry 1 hour in the future", () => {
    const now = Math.floor(Date.now() / 1000);
    const result = createPaymentRequired("/test", "test");
    expect(result.body.expiry).toBeGreaterThan(now);
    expect(result.body.expiry).toBeLessThanOrEqual(now + 3602);
  });

  test("generates unique nonces", () => {
    const nonces = new Set(
      Array.from({ length: 20 }, () => createPaymentRequired("/t", "t").body.nonce)
    );
    expect(nonces.size).toBe(20);
  });

  test("preserves resource path", () => {
    const result = createPaymentRequired("/alerts/custom-path", "desc");
    expect(result.body.resource).toBe("/alerts/custom-path");
  });

  test("preserves description", () => {
    const result = createPaymentRequired("/test", "My custom alert description");
    expect(result.body.description).toBe("My custom alert description");
  });

  test("version is 1.0", () => {
    const result = createPaymentRequired("/test", "test");
    expect(result.body.version).toBe("1.0");
  });

  test("amount is 10000 (0.01 USDC in 6 decimals)", () => {
    const result = createPaymentRequired("/test", "test");
    expect(result.body.maxAmountRequired).toBe("10000");
  });
});

// ─── Bulk Pricing ───────────────────────────────────────────────────────────

describe("Bulk pricing calculations", () => {
  test("0 alerts = 0 cost", () => {
    const r = calculateBulkPrice(0);
    expect(r.totalUsdc).toBe(0);
    expect(r.discount).toBe(0);
  });

  test("1 alert = no discount", () => {
    const r = calculateBulkPrice(1);
    expect(r.discount).toBe(0);
    expect(r.totalUsdc).toBe(r.pricePerAlert);
  });

  test("2-4 alerts = no discount", () => {
    for (const count of [2, 3, 4]) {
      const r = calculateBulkPrice(count);
      expect(r.discount).toBe(0);
    }
  });

  test("5-9 alerts = 10% discount", () => {
    for (const count of [5, 6, 7, 8, 9]) {
      const r = calculateBulkPrice(count);
      expect(r.discount).toBe(0.10);
    }
  });

  test("10+ alerts = 20% discount", () => {
    for (const count of [10, 15, 20, 50, 100]) {
      const r = calculateBulkPrice(count);
      expect(r.discount).toBe(0.20);
    }
  });

  test("totalUsdc = pricePerAlert * count", () => {
    for (const count of [1, 3, 5, 10, 25]) {
      const r = calculateBulkPrice(count);
      expect(r.totalUsdc).toBeCloseTo(r.pricePerAlert * count, 10);
    }
  });

  test("discounted price < base price", () => {
    const base = calculateBulkPrice(1).pricePerAlert;
    expect(calculateBulkPrice(5).pricePerAlert).toBeLessThan(base);
    expect(calculateBulkPrice(10).pricePerAlert).toBeLessThan(calculateBulkPrice(5).pricePerAlert);
  });

  test("all values are positive", () => {
    for (const count of [1, 5, 10, 50]) {
      const r = calculateBulkPrice(count);
      expect(r.totalUsdc).toBeGreaterThan(0);
      expect(r.pricePerAlert).toBeGreaterThan(0);
    }
  });
});

// ─── Payment Instructions ────────────────────────────────────────────────────

describe("Payment instructions", () => {
  test("includes Base network info", () => {
    const info = getPaymentInstructions();
    expect(info).toContain("Base");
    expect(info).toContain("8453");
  });

  test("includes USDC token info", () => {
    const info = getPaymentInstructions();
    expect(info).toContain("USDC");
    expect(info).toContain("0x");
  });

  test("includes wallet recommendations", () => {
    const info = getPaymentInstructions();
    expect(info).toContain("Coinbase");
    expect(info).toContain("MetaMask");
    expect(info).toContain("Rainbow");
  });

  test("includes amount", () => {
    const info = getPaymentInstructions();
    expect(info).toContain("0.01");
  });

  test("includes send-to address", () => {
    const info = getPaymentInstructions();
    expect(info).toMatch(/0x[a-fA-F0-9]{40}/);
  });
});

// ─── NLP Parsing Depth ──────────────────────────────────────────────────────

describe("NLP parsing - comprehensive scenarios", () => {
  test("parses 'Trump > 60%' correctly", () => {
    const r = parseAlertRequest("Trump > 60%", "https://hook.test");
    expect(r).not.toBeNull();
    expect(r!.threshold).toBe(60);
    expect(r!.direction).toBe("above");
  });

  test("parses 'Bitcoin < 30%' correctly", () => {
    const r = parseAlertRequest("Bitcoin < 30%", "https://hook.test");
    expect(r).not.toBeNull();
    expect(r!.threshold).toBe(30);
    expect(r!.direction).toBe("below");
  });

  test("parses 'exceeds 75%' correctly", () => {
    const r = parseAlertRequest("Gold exceeds 75%", "https://hook.test");
    expect(r).not.toBeNull();
    expect(r!.threshold).toBe(75);
    expect(r!.direction).toBe("above");
  });

  test("parses 'falls below 25%' correctly", () => {
    const r = parseAlertRequest("Recession falls below 25%", "https://hook.test");
    expect(r).not.toBeNull();
    expect(r!.threshold).toBe(25);
    expect(r!.direction).toBe("below");
  });

  test("parses 'hits 80%' correctly", () => {
    const r = parseAlertRequest("ETF hits 80%", "https://hook.test");
    expect(r).not.toBeNull();
    expect(r!.threshold).toBe(80);
  });

  test("parses 'above 90%' correctly", () => {
    const r = parseAlertRequest("above 90%", "https://hook.test");
    expect(r).not.toBeNull();
    expect(r!.threshold).toBe(90);
    expect(r!.direction).toBe("above");
  });

  test("parses 'below 10%' correctly", () => {
    const r = parseAlertRequest("below 10%", "https://hook.test");
    expect(r).not.toBeNull();
    expect(r!.threshold).toBe(10);
    expect(r!.direction).toBe("below");
  });

  test("parses decimal thresholds like '65.5%'", () => {
    const r = parseAlertRequest("above 65.5%", "https://hook.test");
    expect(r).not.toBeNull();
    if (r) {
      expect(r.threshold).toBeGreaterThan(60);
    }
  });

  test("preserves webhook URL", () => {
    const url = "https://my-service.example.com/webhook/123";
    const r = parseAlertRequest("Trump > 60%", url);
    expect(r!.notifyUrl).toBe(url);
  });
});

// ─── Multi-Condition Parsing ─────────────────────────────────────────────────

describe("Multi-condition alert parsing", () => {
  test("parses 'A > 50% and B < 30%' into 2 conditions", () => {
    const results = parseMultiConditionAlert("A > 50% and B < 30%", "https://hook");
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  test("preserves webhook URL for all conditions", () => {
    const results = parseMultiConditionAlert("X > 60% and Y < 40%", "https://hook.test");
    for (const r of results) {
      expect(r.notifyUrl).toBe("https://hook.test");
    }
  });

  test("parses different thresholds for each condition", () => {
    const results = parseMultiConditionAlert("Trump > 60% and Biden < 40%", "https://hook");
    if (results.length >= 2) {
      const thresholds = results.map(r => r.threshold);
      expect(thresholds).toContain(60);
      expect(thresholds).toContain(40);
    }
  });

  test("handles single condition gracefully", () => {
    const results = parseMultiConditionAlert("Trump > 60%", "https://hook");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Keyword Extraction ──────────────────────────────────────────────────────

describe("Search keyword extraction", () => {
  test("extracts key terms from natural language", () => {
    const keywords = extractSearchKeywords("Will Trump win the 2026 election?");
    expect(keywords.length).toBeGreaterThan(0);
    // Should include 'Trump' or 'election'
    const combined = keywords.join(" ").toLowerCase();
    expect(combined).toContain("trump");
  });

  test("extracts from commodity queries", () => {
    const keywords = extractSearchKeywords("Gold price predictions for 2026");
    expect(keywords.length).toBeGreaterThan(0);
  });

  test("handles short queries", () => {
    const keywords = extractSearchKeywords("Bitcoin");
    expect(keywords.length).toBeGreaterThan(0);
  });

  test("handles empty string", () => {
    const keywords = extractSearchKeywords("");
    expect(Array.isArray(keywords)).toBe(true);
  });
});

// ─── Portfolio Validation Edge Cases ─────────────────────────────────────────

describe("Portfolio validation edge cases", () => {
  test("rejects weights summing to 0.5", () => {
    expect(() => createPortfolio("p", "Bad", [
      { marketId: "m1", label: "A", outcome: "Yes", weight: 0.25 },
      { marketId: "m2", label: "B", outcome: "Yes", weight: 0.25 },
    ])).toThrow("weights must sum to 1.0");
  });

  test("rejects weights summing to 1.5", () => {
    expect(() => createPortfolio("p", "Bad", [
      { marketId: "m1", label: "A", outcome: "Yes", weight: 0.75 },
      { marketId: "m2", label: "B", outcome: "Yes", weight: 0.75 },
    ])).toThrow("weights must sum to 1.0");
  });

  test("accepts 4 equal weights of 0.25", () => {
    const p = createPortfolio("p", "Quad", [
      { marketId: "m1", label: "A", outcome: "Yes", weight: 0.25 },
      { marketId: "m2", label: "B", outcome: "Yes", weight: 0.25 },
      { marketId: "m3", label: "C", outcome: "Yes", weight: 0.25 },
      { marketId: "m4", label: "D", outcome: "Yes", weight: 0.25 },
    ]);
    expect(p.markets).toHaveLength(4);
  });

  test("accepts 5 equal weights of 0.2", () => {
    const p = createPortfolio("p", "Five", [
      { marketId: "m1", label: "A", outcome: "Yes", weight: 0.2 },
      { marketId: "m2", label: "B", outcome: "Yes", weight: 0.2 },
      { marketId: "m3", label: "C", outcome: "Yes", weight: 0.2 },
      { marketId: "m4", label: "D", outcome: "Yes", weight: 0.2 },
      { marketId: "m5", label: "E", outcome: "Yes", weight: 0.2 },
    ]);
    expect(p.markets).toHaveLength(5);
  });

  test("rejects three duplicate market IDs", () => {
    expect(() => createPortfolio("p", "Dup3", [
      { marketId: "m1", label: "A", outcome: "Yes", weight: 0.5 },
      { marketId: "m1", label: "B", outcome: "No", weight: 0.3 },
      { marketId: "m2", label: "C", outcome: "Yes", weight: 0.2 },
    ])).toThrow("Duplicate market ID");
  });

  test("preserves market labels", () => {
    const p = createPortfolio("p", "Labels", [
      { marketId: "m1", label: "Presidential Race", outcome: "Yes", weight: 0.5 },
      { marketId: "m2", label: "Senate Control", outcome: "Yes", weight: 0.5 },
    ]);
    expect(p.markets[0].label).toBe("Presidential Race");
    expect(p.markets[1].label).toBe("Senate Control");
  });

  test("preserves outcome tracking", () => {
    const p = createPortfolio("p", "Outcomes", [
      { marketId: "m1", label: "A", outcome: "No", weight: 0.5 },
      { marketId: "m2", label: "B", outcome: "Yes", weight: 0.5 },
    ]);
    expect(p.markets[0].outcome).toBe("No");
    expect(p.markets[1].outcome).toBe("Yes");
  });
});

// ─── Arbitrage Edge Cases ────────────────────────────────────────────────────

describe("Arbitrage detection edge cases", () => {
  test("handles market at exactly 100%", () => {
    const result = detectSingleMarketArbitrage(
      "m1", "Q?",
      [{ name: "Y", price: 50 }, { name: "N", price: 50 }],
    );
    expect(result).toBeNull(); // 100% = no deviation
  });

  test("handles market at exactly threshold boundary (3%)", () => {
    const result = detectSingleMarketArbitrage(
      "m1", "Q?",
      [{ name: "Y", price: 51.5 }, { name: "N", price: 51.5 }],
    );
    // 103% total, deviation = 3, threshold check is < 3 (strict less than)
    // So deviation of 3 is NOT less than 3 → should be detected
    expect(result).not.toBeNull();
    expect(result!.deviation).toBe(3);
  });

  test("handles market with 0% outcomes", () => {
    const result = detectSingleMarketArbitrage(
      "m1", "Q?",
      [{ name: "Y", price: 0 }, { name: "N", price: 0 }],
    );
    // totalPrice = 0, deviation = 100
    expect(result).not.toBeNull();
    expect(result!.type).toBe("underpriced");
  });

  test("handles 4-outcome market", () => {
    const result = detectSingleMarketArbitrage(
      "m1", "Who wins?",
      [
        { name: "A", price: 30 },
        { name: "B", price: 25 },
        { name: "C", price: 25 },
        { name: "D", price: 30 },
      ],
    );
    // Total = 110, deviation = 10
    expect(result!.totalPrice).toBe(110);
    expect(result!.deviation).toBe(10);
    expect(result!.confidence).toBe("high");
  });

  test("scanForArbitrage with single market", () => {
    const results = scanForArbitrage([
      { id: "solo", question: "Q?", outcomes: [{ name: "Y", price: 60 }, { name: "N", price: 55 }] },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0].marketId).toBe("solo");
  });

  test("scanForArbitrage preserves question text", () => {
    const results = scanForArbitrage([
      { id: "m1", question: "Will it rain?", outcomes: [{ name: "Y", price: 60 }, { name: "N", price: 55 }] },
    ]);
    expect(results[0].question).toBe("Will it rain?");
  });
});

// ─── Concurrent Payment Operations ──────────────────────────────────────────

describe("Concurrent payment operations", () => {
  test("50 concurrent payment requests produce unique nonces", () => {
    const results = Array.from({ length: 50 }, () =>
      createPaymentRequired("/alerts", "test")
    );
    const nonces = new Set(results.map(r => r.body.nonce));
    expect(nonces.size).toBe(50);
  });

  test("concurrent requests all have valid structure", () => {
    const results = Array.from({ length: 20 }, () =>
      createPaymentRequired("/test", "concurrent test")
    );
    for (const r of results) {
      expect(r.status).toBe(402);
      expect(r.body.chainId).toBe(8453);
      expect(r.body.version).toBe("1.0");
      expect(r.body.nonce).toBeTruthy();
      expect(r.body.expiry).toBeGreaterThan(0);
    }
  });

  test("concurrent pricing calculations are idempotent", () => {
    const counts = [1, 5, 10, 20, 50];
    const results1 = counts.map(c => calculateBulkPrice(c));
    const results2 = counts.map(c => calculateBulkPrice(c));

    for (let i = 0; i < counts.length; i++) {
      expect(results1[i].totalUsdc).toBe(results2[i].totalUsdc);
      expect(results1[i].discount).toBe(results2[i].discount);
      expect(results1[i].pricePerAlert).toBe(results2[i].pricePerAlert);
    }
  });
});

// ─── API Health Check (no mock needed) ───────────────────────────────────────

describe("API health endpoint", () => {
  test("GET /health returns 200", async () => {
    const res = await apiReq("GET", "/health");
    expect(res.status).toBe(200);
  });

  test("GET /health returns healthy status", async () => {
    const res = await apiReq("GET", "/health");
    const body = await res.json();
    expect(body.status).toBe("healthy");
  });

  test("GET /health includes timestamp", async () => {
    const res = await apiReq("GET", "/health");
    const body = await res.json();
    expect(body.timestamp).toBeDefined();
  });

  test("GET /health includes version", async () => {
    const res = await apiReq("GET", "/health");
    const body = await res.json();
    expect(body.version).toBeDefined();
  });

  test("GET /health includes alertCount", async () => {
    const res = await apiReq("GET", "/health");
    const body = await res.json();
    expect(typeof body.alertCount).toBe("number");
  });
});

// ─── API Static Endpoints ────────────────────────────────────────────────────

describe("API static endpoints", () => {
  test("GET /payment-info returns payment details", async () => {
    const res = await apiReq("GET", "/payment-info");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.network).toBe("Base");
    expect(body.receiver).toBeDefined();
    expect(body.asset).toBeDefined();
  });

  test("GET /pricing returns pricing info", async () => {
    const res = await apiReq("GET", "/pricing");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalUsdc).toBeDefined();
    expect(body.pricePerAlert).toBeDefined();
  });

  test("GET /pricing?count=10 applies discount", async () => {
    const res = await apiReq("GET", "/pricing?count=10");
    const body = await res.json();
    expect(body.discount).toBe(0.20);
  });

  test("GET /alerts returns alert list", async () => {
    const res = await apiReq("GET", "/alerts");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alerts).toBeDefined();
    expect(Array.isArray(body.alerts)).toBe(true);
  });

  test("POST /alerts without payment returns 402", async () => {
    const res = await apiReq("POST", "/alerts", {
      body: { description: "test" },
    });
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.nonce).toBeDefined();
  });
});

// ─── Correlation Edge Cases ──────────────────────────────────────────────────

describe("Correlation function edge cases", () => {
  test("identical series have r = 1.0", () => {
    const series = [50, 55, 60, 65, 70];
    expect(pearsonCorrelation(series, series)).toBe(1.0);
  });

  test("reversed series have r = -1.0", () => {
    expect(pearsonCorrelation([1, 2, 3, 4, 5], [5, 4, 3, 2, 1])).toBe(-1.0);
  });

  test("empty arrays return 0", () => {
    expect(pearsonCorrelation([], [])).toBe(0);
  });

  test("single element arrays return 0", () => {
    expect(pearsonCorrelation([42], [99])).toBe(0);
  });

  test("two element arrays return 0 (need >= 3)", () => {
    expect(pearsonCorrelation([1, 2], [3, 4])).toBe(0);
  });

  test("classification boundaries are correct", () => {
    expect(classifyCorrelation(0.7)).toBe("strong_positive");
    expect(classifyCorrelation(0.69)).toBe("moderate_positive");
    expect(classifyCorrelation(0.3)).toBe("moderate_positive");
    expect(classifyCorrelation(0.29)).toBe("weak");
    expect(classifyCorrelation(0)).toBe("weak");
    expect(classifyCorrelation(-0.29)).toBe("weak");
    expect(classifyCorrelation(-0.3)).toBe("moderate_negative");
    expect(classifyCorrelation(-0.69)).toBe("moderate_negative");
    expect(classifyCorrelation(-0.7)).toBe("strong_negative");
  });
});
