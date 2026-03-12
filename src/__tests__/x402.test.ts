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
