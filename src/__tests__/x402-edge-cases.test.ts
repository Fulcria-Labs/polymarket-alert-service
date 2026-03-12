/**
 * x402 Payment Handler Edge Cases
 *
 * Covers: bulk pricing boundaries, payment verification edge cases,
 * payment instructions content, constant exports, nonce entropy,
 * expiry window calculation, concurrent payment requests.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import {
  createPaymentRequired,
  verifyPayment,
  getPaymentInstructions,
  calculateBulkPrice,
} from "../x402-handler";
import x402Default from "../x402-handler";

// ─── Bulk pricing boundaries ────────────────────────────────────────────────

describe("x402 - bulk pricing boundaries", () => {
  test("0 alerts returns 0 total", () => {
    const result = calculateBulkPrice(0);
    expect(result.totalUsdc).toBe(0);
    expect(result.discount).toBe(0);
  });

  test("1 alert has no discount", () => {
    const result = calculateBulkPrice(1);
    expect(result.discount).toBe(0);
    expect(result.pricePerAlert).toBe(0.01);
    expect(result.totalUsdc).toBe(0.01);
  });

  test("2 alerts have no discount", () => {
    const result = calculateBulkPrice(2);
    expect(result.discount).toBe(0);
    expect(result.totalUsdc).toBeCloseTo(0.02, 8);
  });

  test("4 alerts have no discount", () => {
    const result = calculateBulkPrice(4);
    expect(result.discount).toBe(0);
    expect(result.totalUsdc).toBeCloseTo(0.04, 8);
  });

  test("5 alerts have 10% discount", () => {
    const result = calculateBulkPrice(5);
    expect(result.discount).toBe(0.10);
    expect(result.pricePerAlert).toBeCloseTo(0.009, 4);
  });

  test("9 alerts have 10% discount", () => {
    const result = calculateBulkPrice(9);
    expect(result.discount).toBe(0.10);
  });

  test("10 alerts have 20% discount", () => {
    const result = calculateBulkPrice(10);
    expect(result.discount).toBe(0.20);
    expect(result.pricePerAlert).toBeCloseTo(0.008, 4);
  });

  test("50 alerts have 20% discount", () => {
    const result = calculateBulkPrice(50);
    expect(result.discount).toBe(0.20);
  });

  test("100 alerts have 20% discount", () => {
    const result = calculateBulkPrice(100);
    expect(result.discount).toBe(0.20);
  });

  test("1000 alerts have 20% discount", () => {
    const result = calculateBulkPrice(1000);
    expect(result.discount).toBe(0.20);
    expect(result.totalUsdc).toBeCloseTo(8, 4);
  });

  test("total increases linearly within same tier", () => {
    const r1 = calculateBulkPrice(1);
    const r3 = calculateBulkPrice(3);
    expect(r3.totalUsdc).toBeCloseTo(r1.totalUsdc * 3, 8);
  });

  test("price per alert decreases at tier boundary", () => {
    const r4 = calculateBulkPrice(4);
    const r5 = calculateBulkPrice(5);
    expect(r5.pricePerAlert).toBeLessThan(r4.pricePerAlert);
  });

  test("price per alert decreases at 10 tier boundary", () => {
    const r9 = calculateBulkPrice(9);
    const r10 = calculateBulkPrice(10);
    expect(r10.pricePerAlert).toBeLessThan(r9.pricePerAlert);
  });

  test("negative alert count returns 0 total", () => {
    const result = calculateBulkPrice(-1);
    expect(result.totalUsdc).toBeLessThanOrEqual(0);
  });
});

// ─── Payment verification edge cases ────────────────────────────────────────

describe("x402 - payment verification edge cases", () => {
  test("rejects wrong chain ID (Ethereum mainnet)", async () => {
    const result = await verifyPayment({
      transactionHash: "0x" + "a".repeat(64),
      blockNumber: 100,
      chainId: 1, // Ethereum mainnet
      payer: "0x" + "b".repeat(40),
      amount: "10000",
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("chain");
  });

  test("rejects wrong chain ID (Polygon)", async () => {
    const result = await verifyPayment({
      transactionHash: "0x" + "c".repeat(64),
      blockNumber: 200,
      chainId: 137, // Polygon
      payer: "0x" + "d".repeat(40),
      amount: "10000",
    });
    expect(result.valid).toBe(false);
  });

  test("rejects wrong chain ID (Arbitrum)", async () => {
    const result = await verifyPayment({
      transactionHash: "0x" + "e".repeat(64),
      blockNumber: 300,
      chainId: 42161, // Arbitrum
      payer: "0x" + "f".repeat(40),
      amount: "10000",
    });
    expect(result.valid).toBe(false);
  });

  test("rejects chain ID 0", async () => {
    const result = await verifyPayment({
      transactionHash: "0x" + "1".repeat(64),
      blockNumber: 1,
      chainId: 0,
      payer: "0x" + "2".repeat(40),
      amount: "10000",
    });
    expect(result.valid).toBe(false);
  });

  test("rejects negative chain ID", async () => {
    const result = await verifyPayment({
      transactionHash: "0x" + "3".repeat(64),
      blockNumber: 1,
      chainId: -1,
      payer: "0x" + "4".repeat(40),
      amount: "10000",
    });
    expect(result.valid).toBe(false);
  });

  test("correct chain ID proceeds to RPC call (fails in test env)", async () => {
    const result = await verifyPayment({
      transactionHash: "0x" + "5".repeat(64),
      blockNumber: 1,
      chainId: 8453, // Correct chain
      payer: "0x" + "6".repeat(40),
      amount: "10000",
    });
    // Will fail because no real RPC, but should NOT fail on chain ID check
    expect(result.valid).toBe(false);
    expect(result.error).not.toContain("chain");
  });
});

// ─── Payment instructions ──────────────────────────────────────────────────

describe("x402 - payment instructions content", () => {
  test("instructions contain network name", () => {
    const instructions = getPaymentInstructions();
    expect(instructions).toContain("Base");
  });

  test("instructions contain USDC address", () => {
    const instructions = getPaymentInstructions();
    expect(instructions).toContain("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  });

  test("instructions contain chain ID", () => {
    const instructions = getPaymentInstructions();
    expect(instructions).toContain("8453");
  });

  test("instructions contain payment receiver address", () => {
    const instructions = getPaymentInstructions();
    expect(instructions).toContain("0x8Da63b5f30e603E2D11a924C3976F67E63035cF0");
  });

  test("instructions mention USDC amount", () => {
    const instructions = getPaymentInstructions();
    expect(instructions).toContain("0.01");
  });

  test("instructions mention wallet support", () => {
    const instructions = getPaymentInstructions();
    expect(instructions).toContain("Coinbase");
    expect(instructions).toContain("MetaMask");
  });

  test("instructions mention Rainbow wallet", () => {
    const instructions = getPaymentInstructions();
    expect(instructions).toContain("Rainbow");
  });

  test("instructions are multi-line", () => {
    const instructions = getPaymentInstructions();
    expect(instructions.split("\n").length).toBeGreaterThan(3);
  });
});

// ─── Exported constants ────────────────────────────────────────────────────

describe("x402 - exported constants", () => {
  test("PAYMENT_RECEIVER is a valid Ethereum address", () => {
    expect(x402Default.PAYMENT_RECEIVER).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  test("USDC_ADDRESS_BASE is a valid Ethereum address", () => {
    expect(x402Default.USDC_ADDRESS_BASE).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  test("ALERT_PRICE_USDC is a numeric string", () => {
    expect(parseInt(x402Default.ALERT_PRICE_USDC)).not.toBeNaN();
  });

  test("ALERT_PRICE_USDC equals 10000 (0.01 USDC)", () => {
    expect(x402Default.ALERT_PRICE_USDC).toBe("10000");
  });

  test("BASE_CHAIN_ID is 8453", () => {
    expect(x402Default.BASE_CHAIN_ID).toBe(8453);
  });

  test("default export has all expected function keys", () => {
    expect(typeof x402Default.createPaymentRequired).toBe("function");
    expect(typeof x402Default.verifyPayment).toBe("function");
    expect(typeof x402Default.getPaymentInstructions).toBe("function");
    expect(typeof x402Default.calculateBulkPrice).toBe("function");
  });
});

// ─── Nonce uniqueness and entropy ──────────────────────────────────────────

describe("x402 - nonce entropy", () => {
  test("10 sequential nonces are all unique", () => {
    const nonces = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const result = createPaymentRequired("/test", "test");
      nonces.add(result.body.nonce);
    }
    expect(nonces.size).toBe(10);
  });

  test("nonce has minimum length (hex encoded 16 bytes = 34 chars with 0x)", () => {
    const result = createPaymentRequired("/test", "test");
    // 16 bytes = 32 hex chars + "0x" prefix = 34 chars
    expect(result.body.nonce.length).toBeGreaterThanOrEqual(34);
  });

  test("nonce starts with 0x prefix", () => {
    const result = createPaymentRequired("/test", "test");
    expect(result.body.nonce.startsWith("0x")).toBe(true);
  });

  test("nonce contains only valid hex characters", () => {
    const result = createPaymentRequired("/test", "test");
    const hexPart = result.body.nonce.slice(2);
    expect(hexPart).toMatch(/^[0-9a-fA-F]+$/);
  });
});

// ─── Expiry calculation ────────────────────────────────────────────────────

describe("x402 - expiry calculation", () => {
  test("expiry is in the future", () => {
    const now = Math.floor(Date.now() / 1000);
    const result = createPaymentRequired("/test", "test");
    expect(result.body.expiry).toBeGreaterThan(now);
  });

  test("expiry is approximately 1 hour from now", () => {
    const now = Math.floor(Date.now() / 1000);
    const result = createPaymentRequired("/test", "test");
    const diff = result.body.expiry - now;
    expect(diff).toBeGreaterThanOrEqual(3598); // ~1 hour
    expect(diff).toBeLessThanOrEqual(3602); // ~1 hour
  });

  test("expiry is a positive integer", () => {
    const result = createPaymentRequired("/test", "test");
    expect(result.body.expiry).toBeGreaterThan(0);
    expect(Number.isInteger(result.body.expiry)).toBe(true);
  });

  test("consecutive calls have close expiry values", () => {
    const r1 = createPaymentRequired("/test", "test");
    const r2 = createPaymentRequired("/test", "test");
    expect(Math.abs(r1.body.expiry - r2.body.expiry)).toBeLessThanOrEqual(2);
  });
});

// ─── createPaymentRequired with various inputs ────────────────────────────

describe("x402 - createPaymentRequired input handling", () => {
  test("handles empty resource string", () => {
    const result = createPaymentRequired("", "test");
    expect(result.status).toBe(402);
    expect(result.body.resource).toBe("");
  });

  test("handles empty description string", () => {
    const result = createPaymentRequired("/test", "");
    expect(result.status).toBe(402);
    expect(result.body.description).toBe("");
  });

  test("handles very long resource path", () => {
    const longPath = "/" + "a".repeat(1000);
    const result = createPaymentRequired(longPath, "test");
    expect(result.status).toBe(402);
    expect(result.body.resource).toBe(longPath);
  });

  test("handles special characters in resource", () => {
    const result = createPaymentRequired("/test?foo=bar&baz=qux", "desc");
    expect(result.status).toBe(402);
    expect(result.body.resource).toBe("/test?foo=bar&baz=qux");
  });

  test("handles unicode in description", () => {
    const result = createPaymentRequired("/test", "Cr\u00e9er une alerte");
    expect(result.status).toBe(402);
    expect(result.body.description).toContain("\u00e9");
  });

  test("handles newlines in description", () => {
    const result = createPaymentRequired("/test", "Line1\nLine2");
    expect(result.status).toBe(402);
    expect(result.body.description).toContain("\n");
  });
});
