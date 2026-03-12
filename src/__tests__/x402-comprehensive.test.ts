/**
 * Comprehensive tests for x402 Payment Handler
 *
 * Additional coverage for createPaymentRequired, calculateBulkPrice,
 * getPaymentInstructions, verifyPayment, default export, and constants.
 */

import { test, expect, describe } from "bun:test";
import {
  createPaymentRequired,
  verifyPayment,
  getPaymentInstructions,
  calculateBulkPrice,
} from "../x402-handler";
import x402Default from "../x402-handler";

// ─── createPaymentRequired - structure validation ────────────────────────────

describe("createPaymentRequired - response structure", () => {
  test("returns an object with exactly three top-level keys", () => {
    const result = createPaymentRequired("/alerts", "Test");
    const keys = Object.keys(result).sort();
    expect(keys).toEqual(["body", "headers", "status"]);
  });

  test("status is the numeric literal 402", () => {
    const result = createPaymentRequired("/alerts", "Test");
    expect(result.status).toStrictEqual(402);
    expect(typeof result.status).toBe("number");
  });

  test("headers is a plain object with string values", () => {
    const result = createPaymentRequired("/alerts", "Test");
    for (const [key, value] of Object.entries(result.headers)) {
      expect(typeof key).toBe("string");
      expect(typeof value).toBe("string");
    }
  });

  test("body has all X402PaymentRequest fields", () => {
    const result = createPaymentRequired("/alerts", "Test");
    const body = result.body;
    expect(body).toHaveProperty("version");
    expect(body).toHaveProperty("network");
    expect(body).toHaveProperty("chainId");
    expect(body).toHaveProperty("payTo");
    expect(body).toHaveProperty("maxAmountRequired");
    expect(body).toHaveProperty("asset");
    expect(body).toHaveProperty("resource");
    expect(body).toHaveProperty("description");
    expect(body).toHaveProperty("expiry");
    expect(body).toHaveProperty("nonce");
  });

  test("body has exactly 10 fields", () => {
    const result = createPaymentRequired("/alerts", "Test");
    expect(Object.keys(result.body).length).toBe(10);
  });

  test("body field types are correct", () => {
    const result = createPaymentRequired("/alerts", "Test");
    expect(typeof result.body.version).toBe("string");
    expect(typeof result.body.network).toBe("string");
    expect(typeof result.body.chainId).toBe("number");
    expect(typeof result.body.payTo).toBe("string");
    expect(typeof result.body.maxAmountRequired).toBe("string");
    expect(typeof result.body.asset).toBe("string");
    expect(typeof result.body.resource).toBe("string");
    expect(typeof result.body.description).toBe("string");
    expect(typeof result.body.expiry).toBe("number");
    expect(typeof result.body.nonce).toBe("string");
  });
});

// ─── createPaymentRequired - version constant ───────────────────────────────

describe("createPaymentRequired - version constant", () => {
  test("body version is exactly '1.0'", () => {
    const result = createPaymentRequired("/alerts", "desc");
    expect(result.body.version).toBe("1.0");
  });

  test("header X-Payment-Version matches body version", () => {
    const result = createPaymentRequired("/alerts", "desc");
    expect(result.headers["X-Payment-Version"]).toBe(result.body.version);
  });

  test("version is consistent across multiple calls", () => {
    const results = Array.from({ length: 5 }, (_, i) =>
      createPaymentRequired(`/r${i}`, `d${i}`)
    );
    for (const r of results) {
      expect(r.body.version).toBe("1.0");
    }
  });
});

// ─── createPaymentRequired - nonce uniqueness ───────────────────────────────

describe("createPaymentRequired - nonce uniqueness", () => {
  test("10 consecutive calls produce 10 unique nonces", () => {
    const nonces = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const result = createPaymentRequired("/alerts", "desc");
      nonces.add(result.body.nonce);
    }
    expect(nonces.size).toBe(10);
  });

  test("nonces with same resource/description are still unique", () => {
    const a = createPaymentRequired("/same", "same");
    const b = createPaymentRequired("/same", "same");
    const c = createPaymentRequired("/same", "same");
    expect(a.body.nonce).not.toBe(b.body.nonce);
    expect(b.body.nonce).not.toBe(c.body.nonce);
    expect(a.body.nonce).not.toBe(c.body.nonce);
  });

  test("nonce is a valid 0x-prefixed hex string of 16 random bytes (34 chars)", () => {
    const result = createPaymentRequired("/alerts", "desc");
    // 0x + 32 hex chars = 34
    expect(result.body.nonce).toMatch(/^0x[0-9a-f]{32}$/);
  });

  test("nonce has proper hex encoding (lowercase after 0x prefix)", () => {
    const result = createPaymentRequired("/alerts", "desc");
    const hexPart = result.body.nonce.slice(2);
    expect(hexPart).toBe(hexPart.toLowerCase());
  });
});

// ─── createPaymentRequired - expiry ─────────────────────────────────────────

describe("createPaymentRequired - expiry timestamp", () => {
  test("expiry is approximately 1 hour (3600s) from now", () => {
    const beforeSec = Math.floor(Date.now() / 1000);
    const result = createPaymentRequired("/alerts", "desc");
    const afterSec = Math.floor(Date.now() / 1000);

    const expectedMin = beforeSec + 3600;
    const expectedMax = afterSec + 3600;

    expect(result.body.expiry).toBeGreaterThanOrEqual(expectedMin);
    expect(result.body.expiry).toBeLessThanOrEqual(expectedMax);
  });

  test("expiry is an integer (no fractional seconds)", () => {
    const result = createPaymentRequired("/alerts", "desc");
    expect(Number.isInteger(result.body.expiry)).toBe(true);
  });

  test("expiry is between 3599 and 3601 seconds from now", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const result = createPaymentRequired("/alerts", "desc");
    const delta = result.body.expiry - nowSec;
    expect(delta).toBeGreaterThanOrEqual(3599);
    expect(delta).toBeLessThanOrEqual(3601);
  });

  test("two calls within same second have same or very close expiry", () => {
    const r1 = createPaymentRequired("/a", "d");
    const r2 = createPaymentRequired("/b", "d");
    expect(Math.abs(r1.body.expiry - r2.body.expiry)).toBeLessThanOrEqual(1);
  });
});

// ─── createPaymentRequired - resource/description pass-through ──────────────

describe("createPaymentRequired - resource/description pass-through", () => {
  test("resource passes through exactly", () => {
    const result = createPaymentRequired("/my/custom/path?query=1", "desc");
    expect(result.body.resource).toBe("/my/custom/path?query=1");
  });

  test("description passes through exactly", () => {
    const result = createPaymentRequired("/r", "My custom description with special chars: !@#$%");
    expect(result.body.description).toBe("My custom description with special chars: !@#$%");
  });

  test("resource with URL-encoded characters passes through", () => {
    const result = createPaymentRequired("/alerts%20test", "desc");
    expect(result.body.resource).toBe("/alerts%20test");
  });

  test("description with newlines passes through", () => {
    const result = createPaymentRequired("/r", "line1\nline2\nline3");
    expect(result.body.description).toBe("line1\nline2\nline3");
  });

  test("resource with trailing slash passes through", () => {
    const result = createPaymentRequired("/alerts/", "desc");
    expect(result.body.resource).toBe("/alerts/");
  });

  test("description with only whitespace passes through", () => {
    const result = createPaymentRequired("/r", "   ");
    expect(result.body.description).toBe("   ");
  });
});

// ─── calculateBulkPrice - zero alerts ───────────────────────────────────────

describe("calculateBulkPrice - zero alerts", () => {
  test("zero alerts returns totalUsdc of 0", () => {
    const result = calculateBulkPrice(0);
    expect(result.totalUsdc).toBe(0);
  });

  test("zero alerts has no discount", () => {
    const result = calculateBulkPrice(0);
    expect(result.discount).toBe(0);
  });

  test("zero alerts pricePerAlert is base price (no discount applied)", () => {
    const result = calculateBulkPrice(0);
    expect(result.pricePerAlert).toBe(0.01);
  });
});

// ─── calculateBulkPrice - single alert ──────────────────────────────────────

describe("calculateBulkPrice - single alert", () => {
  test("single alert totalUsdc equals base price", () => {
    const result = calculateBulkPrice(1);
    expect(result.totalUsdc).toBeCloseTo(0.01, 8);
  });

  test("single alert has zero discount", () => {
    const result = calculateBulkPrice(1);
    expect(result.discount).toBe(0);
  });

  test("single alert pricePerAlert is 0.01", () => {
    const result = calculateBulkPrice(1);
    expect(result.pricePerAlert).toBe(0.01);
  });

  test("single alert: totalUsdc equals pricePerAlert", () => {
    const result = calculateBulkPrice(1);
    expect(result.totalUsdc).toBe(result.pricePerAlert);
  });
});

// ─── calculateBulkPrice - 4 alerts (no discount) ───────────────────────────

describe("calculateBulkPrice - 4 alerts (no discount)", () => {
  test("4 alerts has 0% discount", () => {
    const result = calculateBulkPrice(4);
    expect(result.discount).toBe(0);
  });

  test("4 alerts pricePerAlert is full price", () => {
    const result = calculateBulkPrice(4);
    expect(result.pricePerAlert).toBe(0.01);
  });

  test("4 alerts totalUsdc is 0.04", () => {
    const result = calculateBulkPrice(4);
    expect(result.totalUsdc).toBeCloseTo(0.04, 8);
  });
});

// ─── calculateBulkPrice - 5 alerts (10% discount) ──────────────────────────

describe("calculateBulkPrice - 5 alerts (10% discount)", () => {
  test("5 alerts triggers 10% discount", () => {
    const result = calculateBulkPrice(5);
    expect(result.discount).toBe(0.10);
  });

  test("5 alerts pricePerAlert is 0.009", () => {
    const result = calculateBulkPrice(5);
    expect(result.pricePerAlert).toBeCloseTo(0.009, 8);
  });

  test("5 alerts totalUsdc is 0.045", () => {
    const result = calculateBulkPrice(5);
    expect(result.totalUsdc).toBeCloseTo(0.045, 8);
  });

  test("5 alerts costs less than 5 * full price", () => {
    const result = calculateBulkPrice(5);
    expect(result.totalUsdc).toBeLessThan(0.01 * 5);
  });
});

// ─── calculateBulkPrice - 9 alerts (10% discount) ──────────────────────────

describe("calculateBulkPrice - 9 alerts (10% discount)", () => {
  test("9 alerts has 10% discount", () => {
    const result = calculateBulkPrice(9);
    expect(result.discount).toBe(0.10);
  });

  test("9 alerts pricePerAlert is 0.009", () => {
    const result = calculateBulkPrice(9);
    expect(result.pricePerAlert).toBeCloseTo(0.009, 8);
  });

  test("9 alerts totalUsdc is 0.081", () => {
    const result = calculateBulkPrice(9);
    expect(result.totalUsdc).toBeCloseTo(0.081, 8);
  });
});

// ─── calculateBulkPrice - 10 alerts (20% discount) ─────────────────────────

describe("calculateBulkPrice - 10 alerts (20% discount)", () => {
  test("10 alerts triggers 20% discount", () => {
    const result = calculateBulkPrice(10);
    expect(result.discount).toBe(0.20);
  });

  test("10 alerts pricePerAlert is 0.008", () => {
    const result = calculateBulkPrice(10);
    expect(result.pricePerAlert).toBeCloseTo(0.008, 8);
  });

  test("10 alerts totalUsdc is 0.08", () => {
    const result = calculateBulkPrice(10);
    expect(result.totalUsdc).toBeCloseTo(0.08, 8);
  });

  test("10 alerts costs less than 9 alerts at 10% discount", () => {
    // 10 * 0.008 = 0.08 vs 9 * 0.009 = 0.081
    const r10 = calculateBulkPrice(10);
    const r9 = calculateBulkPrice(9);
    expect(r10.totalUsdc).toBeLessThan(r9.totalUsdc);
  });
});

// ─── calculateBulkPrice - 100 alerts (20% discount) ────────────────────────

describe("calculateBulkPrice - 100 alerts (20% discount)", () => {
  test("100 alerts has 20% discount", () => {
    const result = calculateBulkPrice(100);
    expect(result.discount).toBe(0.20);
  });

  test("100 alerts pricePerAlert is 0.008", () => {
    const result = calculateBulkPrice(100);
    expect(result.pricePerAlert).toBeCloseTo(0.008, 8);
  });

  test("100 alerts totalUsdc is 0.80", () => {
    const result = calculateBulkPrice(100);
    expect(result.totalUsdc).toBeCloseTo(0.80, 8);
  });

  test("100 alerts total equals 100 * pricePerAlert", () => {
    const result = calculateBulkPrice(100);
    expect(result.totalUsdc).toBeCloseTo(result.pricePerAlert * 100, 8);
  });
});

// ─── calculateBulkPrice - discount boundaries ──────────────────────────────

describe("calculateBulkPrice - discount boundaries at 5 and 10", () => {
  test("count 4 -> 0% discount, count 5 -> 10% discount", () => {
    expect(calculateBulkPrice(4).discount).toBe(0);
    expect(calculateBulkPrice(5).discount).toBe(0.10);
  });

  test("count 9 -> 10% discount, count 10 -> 20% discount", () => {
    expect(calculateBulkPrice(9).discount).toBe(0.10);
    expect(calculateBulkPrice(10).discount).toBe(0.20);
  });

  test("pricePerAlert drops at boundary 5", () => {
    const below = calculateBulkPrice(4).pricePerAlert;
    const at = calculateBulkPrice(5).pricePerAlert;
    expect(at).toBeLessThan(below);
  });

  test("pricePerAlert drops at boundary 10", () => {
    const below = calculateBulkPrice(9).pricePerAlert;
    const at = calculateBulkPrice(10).pricePerAlert;
    expect(at).toBeLessThan(below);
  });

  test("discount does not change between 5 and 9 (all 10%)", () => {
    for (let i = 5; i <= 9; i++) {
      expect(calculateBulkPrice(i).discount).toBe(0.10);
    }
  });

  test("discount does not change between 10 and 100 (all 20%)", () => {
    for (const n of [10, 20, 50, 75, 100]) {
      expect(calculateBulkPrice(n).discount).toBe(0.20);
    }
  });

  test("discount is monotonically non-decreasing for counts 1 through 20", () => {
    let prevDiscount = 0;
    for (let i = 1; i <= 20; i++) {
      const d = calculateBulkPrice(i).discount;
      expect(d).toBeGreaterThanOrEqual(prevDiscount);
      prevDiscount = d;
    }
  });

  test("totalUsdc at count=10 can be less than count=9 due to discount jump", () => {
    // 9 * 0.009 = 0.081, 10 * 0.008 = 0.08
    const r9 = calculateBulkPrice(9);
    const r10 = calculateBulkPrice(10);
    expect(r10.totalUsdc).toBeLessThan(r9.totalUsdc);
  });

  test("totalUsdc is increasing within each discount tier", () => {
    // Tier 1: 1-4 (0% discount)
    for (let i = 2; i <= 4; i++) {
      expect(calculateBulkPrice(i).totalUsdc).toBeGreaterThan(
        calculateBulkPrice(i - 1).totalUsdc
      );
    }
    // Tier 2: 5-9 (10% discount)
    for (let i = 6; i <= 9; i++) {
      expect(calculateBulkPrice(i).totalUsdc).toBeGreaterThan(
        calculateBulkPrice(i - 1).totalUsdc
      );
    }
    // Tier 3: 10-15 (20% discount)
    for (let i = 11; i <= 15; i++) {
      expect(calculateBulkPrice(i).totalUsdc).toBeGreaterThan(
        calculateBulkPrice(i - 1).totalUsdc
      );
    }
  });
});

// ─── getPaymentInstructions - required info ─────────────────────────────────

describe("getPaymentInstructions - contains all required info", () => {
  test("contains chain ID 8453", () => {
    expect(getPaymentInstructions()).toContain("8453");
  });

  test("contains USDC contract address", () => {
    expect(getPaymentInstructions()).toContain("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  });

  test("contains receiver address", () => {
    expect(getPaymentInstructions()).toContain("0x8Da63b5f30e603E2D11a924C3976F67E63035cF0");
  });

  test("contains price 0.01 USDC", () => {
    expect(getPaymentInstructions()).toContain("0.01");
  });

  test("mentions USDC token name", () => {
    expect(getPaymentInstructions()).toContain("USDC");
  });

  test("mentions Base network name", () => {
    expect(getPaymentInstructions()).toContain("Base");
  });
});

// ─── getPaymentInstructions - format ────────────────────────────────────────

describe("getPaymentInstructions - format validation", () => {
  test("returns a non-empty string", () => {
    const result = getPaymentInstructions();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("result is trimmed (no leading/trailing whitespace)", () => {
    const result = getPaymentInstructions();
    expect(result).toBe(result.trim());
  });

  test("result starts with ##", () => {
    const result = getPaymentInstructions();
    expect(result.startsWith("##")).toBe(true);
  });

  test("result contains at least 100 characters", () => {
    const result = getPaymentInstructions();
    expect(result.length).toBeGreaterThan(100);
  });

  test("result is idempotent", () => {
    expect(getPaymentInstructions()).toBe(getPaymentInstructions());
  });

  test("result includes wallet section heading", () => {
    const result = getPaymentInstructions();
    expect(result).toContain("Wallet Support");
  });

  test("result mentions how to activate alert after payment", () => {
    const result = getPaymentInstructions();
    expect(result.toLowerCase()).toContain("transaction hash");
    expect(result.toLowerCase()).toContain("activate");
  });
});

// ─── verifyPayment - chainId validation ─────────────────────────────────────

describe("verifyPayment - chainId validation", () => {
  test("wrong chainId (Ethereum mainnet = 1) is rejected", async () => {
    const result = await verifyPayment({
      transactionHash: "0xabc",
      blockNumber: 1,
      chainId: 1,
      payer: "0x1234",
      amount: "10000",
    });
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("Base");
  });

  test("wrong chainId (Sepolia = 11155111) is rejected", async () => {
    const result = await verifyPayment({
      transactionHash: "0xabc",
      blockNumber: 1,
      chainId: 11155111,
      payer: "0x1234",
      amount: "10000",
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/chain/i);
  });

  test("wrong chainId (Base Goerli = 84531) is rejected", async () => {
    const result = await verifyPayment({
      transactionHash: "0xabc",
      blockNumber: 1,
      chainId: 84531,
      payer: "0x1234",
      amount: "10000",
    });
    expect(result.valid).toBe(false);
  });

  test("wrong chainId (Solana-like = 900) is rejected", async () => {
    const result = await verifyPayment({
      transactionHash: "0xabc",
      blockNumber: 1,
      chainId: 900,
      payer: "0x1234",
      amount: "10000",
    });
    expect(result.valid).toBe(false);
  });

  test("correct chainId 8453 passes chainId check (fails at RPC)", async () => {
    const result = await verifyPayment({
      transactionHash: "0x0000000000000000000000000000000000000000000000000000000000000001",
      blockNumber: 1,
      chainId: 8453,
      payer: "0x1234",
      amount: "10000",
    });
    expect(result.valid).toBe(false);
    // Should NOT be a chain ID error - it should be an RPC/tx-not-found error
    if (result.error) {
      expect(result.error).not.toContain("chain ID");
    }
  });

  test("error message for wrong chainId mentions 'Base'", async () => {
    const result = await verifyPayment({
      transactionHash: "0xabc",
      blockNumber: 1,
      chainId: 42161,
      payer: "0x1234",
      amount: "10000",
    });
    expect(result.error).toContain("Base");
  });

  test("error for wrong chainId is a non-empty string", async () => {
    const result = await verifyPayment({
      transactionHash: "0xabc",
      blockNumber: 1,
      chainId: 250,
      payer: "0x1234",
      amount: "10000",
    });
    expect(typeof result.error).toBe("string");
    expect(result.error!.length).toBeGreaterThan(0);
  });

  test("result shape includes valid:false and error when chainId is wrong", async () => {
    const result = await verifyPayment({
      transactionHash: "0x123",
      blockNumber: 5,
      chainId: 100,
      payer: "0xabc",
      amount: "10000",
    });
    expect(result).toHaveProperty("valid", false);
    expect(result).toHaveProperty("error");
  });
});

// ─── Default export ─────────────────────────────────────────────────────────

describe("x402 default export - contains all expected exports", () => {
  test("exports createPaymentRequired as a function", () => {
    expect(typeof x402Default.createPaymentRequired).toBe("function");
  });

  test("exports verifyPayment as a function", () => {
    expect(typeof x402Default.verifyPayment).toBe("function");
  });

  test("exports getPaymentInstructions as a function", () => {
    expect(typeof x402Default.getPaymentInstructions).toBe("function");
  });

  test("exports calculateBulkPrice as a function", () => {
    expect(typeof x402Default.calculateBulkPrice).toBe("function");
  });

  test("exports PAYMENT_RECEIVER as a string", () => {
    expect(typeof x402Default.PAYMENT_RECEIVER).toBe("string");
  });

  test("exports USDC_ADDRESS_BASE as a string", () => {
    expect(typeof x402Default.USDC_ADDRESS_BASE).toBe("string");
  });

  test("exports ALERT_PRICE_USDC as a string", () => {
    expect(typeof x402Default.ALERT_PRICE_USDC).toBe("string");
  });

  test("exports BASE_CHAIN_ID as a number", () => {
    expect(typeof x402Default.BASE_CHAIN_ID).toBe("number");
  });

  test("default export has exactly 8 keys", () => {
    expect(Object.keys(x402Default).length).toBe(8);
  });

  test("all 8 expected keys are present", () => {
    const expectedKeys = [
      "createPaymentRequired",
      "verifyPayment",
      "getPaymentInstructions",
      "calculateBulkPrice",
      "PAYMENT_RECEIVER",
      "USDC_ADDRESS_BASE",
      "ALERT_PRICE_USDC",
      "BASE_CHAIN_ID",
    ];
    for (const key of expectedKeys) {
      expect(x402Default).toHaveProperty(key);
    }
  });

  test("exported functions match named exports", () => {
    expect(x402Default.createPaymentRequired).toBe(createPaymentRequired);
    expect(x402Default.verifyPayment).toBe(verifyPayment);
    expect(x402Default.getPaymentInstructions).toBe(getPaymentInstructions);
    expect(x402Default.calculateBulkPrice).toBe(calculateBulkPrice);
  });
});

// ─── Constants validation ───────────────────────────────────────────────────

describe("Constants validation", () => {
  test("BASE_CHAIN_ID is exactly 8453", () => {
    expect(x402Default.BASE_CHAIN_ID).toBe(8453);
  });

  test("BASE_CHAIN_ID is a positive integer", () => {
    expect(Number.isInteger(x402Default.BASE_CHAIN_ID)).toBe(true);
    expect(x402Default.BASE_CHAIN_ID).toBeGreaterThan(0);
  });

  test("ALERT_PRICE_USDC is a numeric string", () => {
    expect(x402Default.ALERT_PRICE_USDC).toMatch(/^\d+$/);
  });

  test("ALERT_PRICE_USDC equals '10000' (0.01 USDC with 6 decimals)", () => {
    expect(x402Default.ALERT_PRICE_USDC).toBe("10000");
  });

  test("ALERT_PRICE_USDC parses to a valid number", () => {
    const value = parseInt(x402Default.ALERT_PRICE_USDC, 10);
    expect(value).toBe(10000);
    expect(isNaN(value)).toBe(false);
  });

  test("ALERT_PRICE_USDC represents 0.01 USDC (6 decimals)", () => {
    const humanReadable = parseInt(x402Default.ALERT_PRICE_USDC) / 1e6;
    expect(humanReadable).toBe(0.01);
  });

  test("USDC_ADDRESS_BASE is a valid Ethereum address format", () => {
    expect(x402Default.USDC_ADDRESS_BASE).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  test("USDC_ADDRESS_BASE is the known Base USDC address", () => {
    expect(x402Default.USDC_ADDRESS_BASE).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  });

  test("PAYMENT_RECEIVER is a valid Ethereum address format", () => {
    expect(x402Default.PAYMENT_RECEIVER).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  test("PAYMENT_RECEIVER has correct checksum format", () => {
    // The address should be 42 chars (0x + 40 hex)
    expect(x402Default.PAYMENT_RECEIVER.length).toBe(42);
    expect(x402Default.PAYMENT_RECEIVER.startsWith("0x")).toBe(true);
  });

  test("USDC_ADDRESS_BASE has correct length (42 chars)", () => {
    expect(x402Default.USDC_ADDRESS_BASE.length).toBe(42);
  });

  test("ALERT_PRICE_USDC is not empty", () => {
    expect(x402Default.ALERT_PRICE_USDC.length).toBeGreaterThan(0);
  });

  test("ALERT_PRICE_USDC has no whitespace", () => {
    expect(x402Default.ALERT_PRICE_USDC).toBe(x402Default.ALERT_PRICE_USDC.trim());
  });
});

// ─── Cross-function consistency ─────────────────────────────────────────────

describe("Cross-function consistency", () => {
  test("createPaymentRequired uses same chainId as BASE_CHAIN_ID constant", () => {
    const result = createPaymentRequired("/alerts", "desc");
    expect(result.body.chainId).toBe(x402Default.BASE_CHAIN_ID);
  });

  test("createPaymentRequired uses same USDC address as constant", () => {
    const result = createPaymentRequired("/alerts", "desc");
    expect(result.body.asset).toBe(x402Default.USDC_ADDRESS_BASE);
  });

  test("createPaymentRequired uses same price as ALERT_PRICE_USDC", () => {
    const result = createPaymentRequired("/alerts", "desc");
    expect(result.body.maxAmountRequired).toBe(x402Default.ALERT_PRICE_USDC);
  });

  test("getPaymentInstructions references same chain ID as constant", () => {
    const instructions = getPaymentInstructions();
    expect(instructions).toContain(String(x402Default.BASE_CHAIN_ID));
  });

  test("getPaymentInstructions references same USDC address as constant", () => {
    const instructions = getPaymentInstructions();
    expect(instructions).toContain(x402Default.USDC_ADDRESS_BASE);
  });

  test("getPaymentInstructions references same price as ALERT_PRICE_USDC", () => {
    const instructions = getPaymentInstructions();
    const humanPrice = parseInt(x402Default.ALERT_PRICE_USDC) / 1e6;
    expect(instructions).toContain(String(humanPrice));
  });

  test("calculateBulkPrice base price matches ALERT_PRICE_USDC", () => {
    const result = calculateBulkPrice(1);
    const expectedBase = parseInt(x402Default.ALERT_PRICE_USDC) / 1e6;
    expect(result.pricePerAlert).toBe(expectedBase);
  });

  test("verifyPayment accepts BASE_CHAIN_ID without chain error", async () => {
    const result = await verifyPayment({
      transactionHash: "0x0000000000000000000000000000000000000000000000000000000000000001",
      blockNumber: 1,
      chainId: x402Default.BASE_CHAIN_ID,
      payer: "0x1234",
      amount: "10000",
    });
    // It fails at RPC level, not chain ID validation
    if (result.error) {
      expect(result.error.toLowerCase()).not.toContain("chain id");
    }
  });
});

// ─── calculateBulkPrice - savings calculations ─────────────────────────────

describe("calculateBulkPrice - savings amount", () => {
  const BASE = 0.01;

  test("savings at 5 alerts = 10% of full price", () => {
    const r = calculateBulkPrice(5);
    const fullPrice = BASE * 5;
    const savings = fullPrice - r.totalUsdc;
    expect(savings).toBeCloseTo(fullPrice * 0.10, 8);
  });

  test("savings at 10 alerts = 20% of full price", () => {
    const r = calculateBulkPrice(10);
    const fullPrice = BASE * 10;
    const savings = fullPrice - r.totalUsdc;
    expect(savings).toBeCloseTo(fullPrice * 0.20, 8);
  });

  test("2 alerts no discount equals exactly 2x base price", () => {
    const r = calculateBulkPrice(2);
    expect(r.totalUsdc).toBeCloseTo(BASE * 2, 10);
  });

  test("3 alerts no discount equals exactly 3x base price", () => {
    const r = calculateBulkPrice(3);
    expect(r.totalUsdc).toBeCloseTo(BASE * 3, 10);
  });

  test("6 alerts at 10% = 0.054 USDC", () => {
    const r = calculateBulkPrice(6);
    expect(r.totalUsdc).toBeCloseTo(0.054, 8);
  });

  test("7 alerts at 10% = 0.063 USDC", () => {
    const r = calculateBulkPrice(7);
    expect(r.totalUsdc).toBeCloseTo(0.063, 8);
  });

  test("8 alerts at 10% = 0.072 USDC", () => {
    const r = calculateBulkPrice(8);
    expect(r.totalUsdc).toBeCloseTo(0.072, 8);
  });

  test("15 alerts at 20% = 0.12 USDC", () => {
    const r = calculateBulkPrice(15);
    expect(r.totalUsdc).toBeCloseTo(0.12, 8);
  });

  test("25 alerts at 20% = 0.20 USDC", () => {
    const r = calculateBulkPrice(25);
    expect(r.totalUsdc).toBeCloseTo(0.20, 8);
  });

  test("50 alerts at 20% = 0.40 USDC", () => {
    const r = calculateBulkPrice(50);
    expect(r.totalUsdc).toBeCloseTo(0.40, 8);
  });
});
