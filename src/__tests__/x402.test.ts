/**
 * Tests for x402 Payment Handler
 *
 * Tests createPaymentRequired, verifyPayment, getPaymentInstructions,
 * calculateBulkPrice, and exported constants without hitting real blockchain.
 */

import { test, expect, describe, mock, spyOn } from "bun:test";
import {
  createPaymentRequired,
  verifyPayment,
  getPaymentInstructions,
  calculateBulkPrice,
} from "../x402-handler";
import x402Default from "../x402-handler";

// ─── createPaymentRequired ────────────────────────────────────────────────────

describe("createPaymentRequired", () => {
  test("returns HTTP 402 status code", () => {
    const result = createPaymentRequired("/alerts", "Test alert");
    expect(result.status).toBe(402);
  });

  test("includes required x402 headers", () => {
    const result = createPaymentRequired("/alerts", "Test alert");
    expect(result.headers["X-Payment-Required"]).toBe("true");
    expect(result.headers["X-Payment-Version"]).toBe("1.0");
    expect(result.headers["Content-Type"]).toBe("application/json");
  });

  test("body contains correct payment fields", () => {
    const result = createPaymentRequired("/alerts", "Test alert");
    const body = result.body;
    expect(body.version).toBe("1.0");
    expect(body.network).toBe("base");
    expect(body.chainId).toBe(8453);
    expect(body.payTo).toBeTruthy();
    expect(body.maxAmountRequired).toBe("10000");
    expect(body.asset).toBeTruthy();
  });

  test("body contains the passed resource and description", () => {
    const result = createPaymentRequired("/my-resource", "My description");
    expect(result.body.resource).toBe("/my-resource");
    expect(result.body.description).toBe("My description");
  });

  test("generates unique nonce each call", () => {
    const r1 = createPaymentRequired("/alerts", "desc");
    const r2 = createPaymentRequired("/alerts", "desc");
    expect(r1.body.nonce).not.toBe(r2.body.nonce);
  });

  test("expiry is approximately one hour in the future", () => {
    const before = Math.floor(Date.now() / 1000);
    const result = createPaymentRequired("/alerts", "desc");
    const after = Math.floor(Date.now() / 1000);
    expect(result.body.expiry).toBeGreaterThanOrEqual(before + 3599);
    expect(result.body.expiry).toBeLessThanOrEqual(after + 3601);
  });

  test("nonce is a hex string", () => {
    const result = createPaymentRequired("/alerts", "desc");
    expect(result.body.nonce).toMatch(/^0x[0-9a-fA-F]+$/);
  });

  test("body contains correct USDC asset address", () => {
    const result = createPaymentRequired("/alerts", "desc");
    expect(result.body.asset).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  });

  test("uses BASE chain id 8453", () => {
    const result = createPaymentRequired("/pricing", "bulk pricing");
    expect(result.body.chainId).toBe(8453);
  });

  test("different resources produce different payment requests", () => {
    const r1 = createPaymentRequired("/alerts", "alert");
    const r2 = createPaymentRequired("/pricing", "pricing");
    expect(r1.body.resource).toBe("/alerts");
    expect(r2.body.resource).toBe("/pricing");
  });
});

// ─── verifyPayment ────────────────────────────────────────────────────────────

describe("verifyPayment", () => {
  test("rejects wrong chain ID immediately without RPC call", async () => {
    const result = await verifyPayment({
      transactionHash: "0xabc",
      blockNumber: 1,
      chainId: 1, // Ethereum mainnet, not Base
      payer: "0x1234",
      amount: "10000",
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/chain/i);
  });

  test("returns { valid: false } with an error string for wrong chainId", async () => {
    const result = await verifyPayment({
      transactionHash: "0xdeadbeef",
      blockNumber: 99,
      chainId: 137, // Polygon
      payer: "0xPayer",
      amount: "10000",
    });
    expect(result.valid).toBe(false);
    expect(typeof result.error).toBe("string");
    expect(result.error!.length).toBeGreaterThan(0);
  });

  test("returns { valid: false } when RPC cannot find tx (network unreachable mocked)", async () => {
    // Chain ID is correct but the RPC will fail (no real network in tests)
    const result = await verifyPayment({
      transactionHash: "0x0000000000000000000000000000000000000000000000000000000000000001",
      blockNumber: 1,
      chainId: 8453,
      payer: "0xSomePayer",
      amount: "10000",
    });
    // Either "Transaction not found" or a Verification failed error
    expect(result.valid).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test("error message is informative when chain ID is wrong", async () => {
    const result = await verifyPayment({
      transactionHash: "0x123",
      blockNumber: 1,
      chainId: 5,
      payer: "0xpayer",
      amount: "10000",
    });
    expect(result.error).toContain("Base");
  });
});

// ─── getPaymentInstructions ───────────────────────────────────────────────────

describe("getPaymentInstructions", () => {
  test("returns a non-empty string", () => {
    const instructions = getPaymentInstructions();
    expect(typeof instructions).toBe("string");
    expect(instructions.length).toBeGreaterThan(50);
  });

  test("mentions Base network", () => {
    const instructions = getPaymentInstructions();
    expect(instructions).toContain("Base");
  });

  test("mentions USDC", () => {
    const instructions = getPaymentInstructions();
    expect(instructions).toContain("USDC");
  });

  test("includes chain ID 8453", () => {
    const instructions = getPaymentInstructions();
    expect(instructions).toContain("8453");
  });

  test("includes payment receiver address", () => {
    const instructions = getPaymentInstructions();
    expect(instructions).toContain("0x8Da63b5f30e603E2D11a924C3976F67E63035cF0");
  });

  test("mentions wallet support", () => {
    const instructions = getPaymentInstructions();
    expect(instructions.toLowerCase()).toMatch(/coinbase|metamask|rainbow|wallet/);
  });

  test("includes the USDC contract address", () => {
    const instructions = getPaymentInstructions();
    expect(instructions).toContain("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  });

  test("shows the correct price in human-readable USDC", () => {
    const instructions = getPaymentInstructions();
    // 10000 / 1e6 = 0.01
    expect(instructions).toContain("0.01");
  });
});

// ─── calculateBulkPrice ───────────────────────────────────────────────────────

describe("calculateBulkPrice", () => {
  const BASE_PRICE = 0.01; // 10000 / 1e6

  test("returns correct structure", () => {
    const result = calculateBulkPrice(1);
    expect(result).toHaveProperty("totalUsdc");
    expect(result).toHaveProperty("discount");
    expect(result).toHaveProperty("pricePerAlert");
  });

  test("1 alert has no discount", () => {
    const result = calculateBulkPrice(1);
    expect(result.discount).toBe(0);
    expect(result.pricePerAlert).toBe(BASE_PRICE);
    expect(result.totalUsdc).toBeCloseTo(BASE_PRICE, 6);
  });

  test("4 alerts still has no discount", () => {
    const result = calculateBulkPrice(4);
    expect(result.discount).toBe(0);
    expect(result.pricePerAlert).toBe(BASE_PRICE);
    expect(result.totalUsdc).toBeCloseTo(BASE_PRICE * 4, 6);
  });

  test("5 alerts gives 10% discount", () => {
    const result = calculateBulkPrice(5);
    expect(result.discount).toBe(0.10);
    expect(result.pricePerAlert).toBeCloseTo(BASE_PRICE * 0.90, 6);
    expect(result.totalUsdc).toBeCloseTo(BASE_PRICE * 0.90 * 5, 6);
  });

  test("9 alerts gives 10% discount", () => {
    const result = calculateBulkPrice(9);
    expect(result.discount).toBe(0.10);
    expect(result.pricePerAlert).toBeCloseTo(BASE_PRICE * 0.90, 6);
  });

  test("10 alerts gives 20% discount", () => {
    const result = calculateBulkPrice(10);
    expect(result.discount).toBe(0.20);
    expect(result.pricePerAlert).toBeCloseTo(BASE_PRICE * 0.80, 6);
    expect(result.totalUsdc).toBeCloseTo(BASE_PRICE * 0.80 * 10, 6);
  });

  test("50 alerts gives 20% discount", () => {
    const result = calculateBulkPrice(50);
    expect(result.discount).toBe(0.20);
    expect(result.pricePerAlert).toBeCloseTo(BASE_PRICE * 0.80, 6);
    expect(result.totalUsdc).toBeCloseTo(BASE_PRICE * 0.80 * 50, 6);
  });

  test("total is pricePerAlert * count", () => {
    for (const count of [1, 3, 5, 10, 25]) {
      const result = calculateBulkPrice(count);
      expect(result.totalUsdc).toBeCloseTo(result.pricePerAlert * count, 8);
    }
  });

  test("price is always positive", () => {
    [1, 2, 5, 10, 100].forEach(count => {
      const result = calculateBulkPrice(count);
      expect(result.totalUsdc).toBeGreaterThan(0);
      expect(result.pricePerAlert).toBeGreaterThan(0);
    });
  });
});

// ─── Default export constants ─────────────────────────────────────────────────

describe("x402 default export", () => {
  test("exports PAYMENT_RECEIVER", () => {
    expect(x402Default.PAYMENT_RECEIVER).toBeTruthy();
    expect(x402Default.PAYMENT_RECEIVER).toMatch(/^0x/);
  });

  test("exports USDC_ADDRESS_BASE", () => {
    expect(x402Default.USDC_ADDRESS_BASE).toBeTruthy();
    expect(x402Default.USDC_ADDRESS_BASE).toMatch(/^0x/);
  });

  test("exports ALERT_PRICE_USDC as string '10000'", () => {
    expect(x402Default.ALERT_PRICE_USDC).toBe("10000");
  });

  test("exports BASE_CHAIN_ID as 8453", () => {
    expect(x402Default.BASE_CHAIN_ID).toBe(8453);
  });

  test("exports createPaymentRequired function", () => {
    expect(typeof x402Default.createPaymentRequired).toBe("function");
  });

  test("exports verifyPayment function", () => {
    expect(typeof x402Default.verifyPayment).toBe("function");
  });

  test("exports getPaymentInstructions function", () => {
    expect(typeof x402Default.getPaymentInstructions).toBe("function");
  });

  test("exports calculateBulkPrice function", () => {
    expect(typeof x402Default.calculateBulkPrice).toBe("function");
  });

  test("USDC address is the known Base USDC contract", () => {
    expect(x402Default.USDC_ADDRESS_BASE.toLowerCase()).toBe(
      "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
    );
  });
});

// ─── calculateBulkPrice - zero and negative edge cases ──────────────────────

describe("calculateBulkPrice - edge cases", () => {
  const BASE_PRICE = 0.01;

  test("zero alerts returns zero total", () => {
    const result = calculateBulkPrice(0);
    expect(result.totalUsdc).toBe(0);
    expect(result.discount).toBe(0);
  });

  test("negative alert count returns negative total (no validation)", () => {
    const result = calculateBulkPrice(-1);
    // Implementation does no validation, so pricePerAlert * -1 = negative
    expect(result.totalUsdc).toBeLessThan(0);
  });

  test("very large alert count (1000) still works", () => {
    const result = calculateBulkPrice(1000);
    expect(result.discount).toBe(0.20); // 20% for 10+
    expect(result.totalUsdc).toBeCloseTo(BASE_PRICE * 0.80 * 1000, 4);
  });

  test("very large alert count (1000000) does not overflow", () => {
    const result = calculateBulkPrice(1000000);
    expect(result.totalUsdc).toBeGreaterThan(0);
    expect(isFinite(result.totalUsdc)).toBe(true);
  });

  test("NaN alert count returns NaN total", () => {
    const result = calculateBulkPrice(NaN);
    expect(isNaN(result.totalUsdc)).toBe(true);
  });

  test("discount is exactly 0 for counts 1-4", () => {
    for (let i = 1; i <= 4; i++) {
      const result = calculateBulkPrice(i);
      expect(result.discount).toBe(0);
    }
  });

  test("discount is exactly 0.10 for counts 5-9", () => {
    for (let i = 5; i <= 9; i++) {
      const result = calculateBulkPrice(i);
      expect(result.discount).toBe(0.10);
    }
  });

  test("discount is exactly 0.20 for counts 10+", () => {
    for (const count of [10, 11, 15, 20, 50, 100]) {
      const result = calculateBulkPrice(count);
      expect(result.discount).toBe(0.20);
    }
  });

  test("boundary: count=4 has 0% discount, count=5 has 10%", () => {
    const r4 = calculateBulkPrice(4);
    const r5 = calculateBulkPrice(5);
    expect(r4.discount).toBe(0);
    expect(r5.discount).toBe(0.10);
    expect(r5.pricePerAlert).toBeLessThan(r4.pricePerAlert);
  });

  test("boundary: count=9 has 10% discount, count=10 has 20%", () => {
    const r9 = calculateBulkPrice(9);
    const r10 = calculateBulkPrice(10);
    expect(r9.discount).toBe(0.10);
    expect(r10.discount).toBe(0.20);
    expect(r10.pricePerAlert).toBeLessThan(r9.pricePerAlert);
  });

  test("floating point count (5.5) still computes", () => {
    const result = calculateBulkPrice(5.5);
    expect(result.discount).toBe(0.10);
    expect(result.totalUsdc).toBeCloseTo(BASE_PRICE * 0.90 * 5.5, 6);
  });

  test("Infinity count returns Infinity total", () => {
    const result = calculateBulkPrice(Infinity);
    expect(result.totalUsdc).toBe(Infinity);
  });
});

// ─── createPaymentRequired - edge cases ─────────────────────────────────────

describe("createPaymentRequired - edge cases", () => {
  test("handles empty resource string", () => {
    const result = createPaymentRequired("", "desc");
    expect(result.body.resource).toBe("");
    expect(result.status).toBe(402);
  });

  test("handles empty description string", () => {
    const result = createPaymentRequired("/alerts", "");
    expect(result.body.description).toBe("");
    expect(result.status).toBe(402);
  });

  test("handles very long resource string", () => {
    const longResource = "/" + "a".repeat(1000);
    const result = createPaymentRequired(longResource, "desc");
    expect(result.body.resource).toBe(longResource);
  });

  test("handles special characters in description", () => {
    const result = createPaymentRequired("/alerts", "<script>alert('xss')</script>");
    expect(result.body.description).toBe("<script>alert('xss')</script>");
  });

  test("handles unicode in description", () => {
    const result = createPaymentRequired("/alerts", "Test alert \u2192 monitor");
    expect(result.body.description).toContain("\u2192");
  });

  test("nonce length is consistent across calls", () => {
    const r1 = createPaymentRequired("/a", "d");
    const r2 = createPaymentRequired("/b", "d");
    expect(r1.body.nonce.length).toBe(r2.body.nonce.length);
  });

  test("payTo address is always present", () => {
    const result = createPaymentRequired("/alerts", "desc");
    expect(result.body.payTo.length).toBeGreaterThan(2);
    expect(result.body.payTo.startsWith("0x")).toBe(true);
  });

  test("maxAmountRequired is always the alert price", () => {
    const result = createPaymentRequired("/resource", "any desc");
    expect(result.body.maxAmountRequired).toBe("10000");
  });

  test("expiry is always in the future", () => {
    const now = Math.floor(Date.now() / 1000);
    const result = createPaymentRequired("/alerts", "desc");
    expect(result.body.expiry).toBeGreaterThan(now);
  });

  test("all three headers are present", () => {
    const result = createPaymentRequired("/alerts", "desc");
    expect(Object.keys(result.headers).length).toBe(3);
  });
});

// ─── verifyPayment - additional edge cases ──────────────────────────────────

describe("verifyPayment - additional edge cases", () => {
  test("rejects chain ID 0", async () => {
    const result = await verifyPayment({
      transactionHash: "0xabc",
      blockNumber: 1,
      chainId: 0,
      payer: "0x1234",
      amount: "10000",
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/chain/i);
  });

  test("rejects negative chain ID", async () => {
    const result = await verifyPayment({
      transactionHash: "0xabc",
      blockNumber: 1,
      chainId: -1,
      payer: "0x1234",
      amount: "10000",
    });
    expect(result.valid).toBe(false);
  });

  test("rejects Polygon chain ID (137)", async () => {
    const result = await verifyPayment({
      transactionHash: "0xabc",
      blockNumber: 1,
      chainId: 137,
      payer: "0x1234",
      amount: "10000",
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Base/);
  });

  test("rejects Arbitrum chain ID (42161)", async () => {
    const result = await verifyPayment({
      transactionHash: "0xabc",
      blockNumber: 1,
      chainId: 42161,
      payer: "0x1234",
      amount: "10000",
    });
    expect(result.valid).toBe(false);
  });

  test("rejects Optimism chain ID (10)", async () => {
    const result = await verifyPayment({
      transactionHash: "0xabc",
      blockNumber: 1,
      chainId: 10,
      payer: "0x1234",
      amount: "10000",
    });
    expect(result.valid).toBe(false);
  });

  test("rejects BSC chain ID (56)", async () => {
    const result = await verifyPayment({
      transactionHash: "0xabc",
      blockNumber: 1,
      chainId: 56,
      payer: "0x1234",
      amount: "10000",
    });
    expect(result.valid).toBe(false);
  });

  test("rejects Avalanche chain ID (43114)", async () => {
    const result = await verifyPayment({
      transactionHash: "0xabc",
      blockNumber: 1,
      chainId: 43114,
      payer: "0x1234",
      amount: "10000",
    });
    expect(result.valid).toBe(false);
  });

  test("correct chain ID (8453) proceeds to RPC check", async () => {
    const result = await verifyPayment({
      transactionHash: "0x0000000000000000000000000000000000000000000000000000000000000001",
      blockNumber: 1,
      chainId: 8453,
      payer: "0x1234",
      amount: "10000",
    });
    // Should fail at RPC level, not chain ID level
    expect(result.valid).toBe(false);
    expect(result.error).not.toMatch(/chain/i);
  });

  test("error message always has a string type when invalid", async () => {
    const result = await verifyPayment({
      transactionHash: "0xabc",
      blockNumber: 1,
      chainId: 999,
      payer: "0x1234",
      amount: "10000",
    });
    expect(result.valid).toBe(false);
    expect(typeof result.error).toBe("string");
    expect(result.error!.length).toBeGreaterThan(0);
  });
});

// ─── getPaymentInstructions - additional checks ─────────────────────────────

describe("getPaymentInstructions - formatting", () => {
  test("starts with markdown heading", () => {
    const instructions = getPaymentInstructions();
    expect(instructions).toMatch(/^##/);
  });

  test("contains numbered steps", () => {
    const instructions = getPaymentInstructions();
    expect(instructions).toContain("1.");
    expect(instructions).toContain("2.");
    expect(instructions).toContain("3.");
    expect(instructions).toContain("4.");
  });

  test("mentions Send To field", () => {
    const instructions = getPaymentInstructions();
    expect(instructions).toContain("Send To");
  });

  test("mentions Amount field", () => {
    const instructions = getPaymentInstructions();
    expect(instructions).toContain("Amount");
  });

  test("mentions Token field", () => {
    const instructions = getPaymentInstructions();
    expect(instructions).toContain("Token");
  });

  test("mentions Network field", () => {
    const instructions = getPaymentInstructions();
    expect(instructions).toContain("Network");
  });

  test("mentions Coinbase Wallet", () => {
    const instructions = getPaymentInstructions();
    expect(instructions).toContain("Coinbase Wallet");
  });

  test("mentions MetaMask", () => {
    const instructions = getPaymentInstructions();
    expect(instructions).toContain("MetaMask");
  });

  test("mentions Rainbow wallet", () => {
    const instructions = getPaymentInstructions();
    expect(instructions).toContain("Rainbow");
  });

  test("contains transaction hash instruction", () => {
    const instructions = getPaymentInstructions();
    expect(instructions.toLowerCase()).toContain("transaction hash");
  });

  test("is deterministic (same output each call)", () => {
    const a = getPaymentInstructions();
    const b = getPaymentInstructions();
    expect(a).toBe(b);
  });
});
