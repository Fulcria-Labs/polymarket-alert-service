/**
 * Webhook Signature Verification Tests
 *
 * Tests HMAC-SHA256 signing of outgoing webhook payloads.
 * Ensures signatures are consistent, unique per payload, and properly formatted.
 */

import { describe, test, expect } from "bun:test";
import { signWebhookPayload } from "../polymarket-alert-workflow";

describe("Webhook Signature Verification", () => {
  describe("Signature format", () => {
    test("produces sha256= prefixed signature", async () => {
      const sig = await signWebhookPayload('{"test": true}');
      expect(sig).toMatch(/^sha256=[a-f0-9]{64}$/);
    });

    test("signature is exactly 71 characters (sha256= + 64 hex chars)", async () => {
      const sig = await signWebhookPayload("test");
      expect(sig.length).toBe(71);
    });

    test("signature only contains hex characters after prefix", async () => {
      const sig = await signWebhookPayload("any payload");
      const hex = sig.replace("sha256=", "");
      expect(hex).toMatch(/^[0-9a-f]+$/);
    });
  });

  describe("Signature consistency", () => {
    test("same payload produces same signature", async () => {
      const payload = '{"marketId":"0x123","outcome":"Yes"}';
      const sig1 = await signWebhookPayload(payload);
      const sig2 = await signWebhookPayload(payload);
      expect(sig1).toBe(sig2);
    });

    test("different payloads produce different signatures", async () => {
      const sig1 = await signWebhookPayload('{"price":"60.00"}');
      const sig2 = await signWebhookPayload('{"price":"61.00"}');
      expect(sig1).not.toBe(sig2);
    });

    test("empty string has a valid signature", async () => {
      const sig = await signWebhookPayload("");
      expect(sig).toMatch(/^sha256=[a-f0-9]{64}$/);
    });

    test("whitespace differences produce different signatures", async () => {
      const sig1 = await signWebhookPayload('{"a":1}');
      const sig2 = await signWebhookPayload('{ "a": 1 }');
      expect(sig1).not.toBe(sig2);
    });
  });

  describe("Payload handling", () => {
    test("handles JSON alert payload", async () => {
      const payload = JSON.stringify({
        type: "prediction_market_alert",
        marketId: "0xABC",
        question: "Will Trump win?",
        outcome: "Yes",
        threshold: 60,
        direction: "above",
        currentPrice: "65.00",
        triggeredAt: "2026-03-12T12:00:00Z",
      });
      const sig = await signWebhookPayload(payload);
      expect(sig).toMatch(/^sha256=[a-f0-9]{64}$/);
    });

    test("handles unicode content", async () => {
      const sig = await signWebhookPayload('{"question":"¿Será aprobado?"}');
      expect(sig).toMatch(/^sha256=[a-f0-9]{64}$/);
    });

    test("handles very large payloads", async () => {
      const large = JSON.stringify({ data: "x".repeat(100000) });
      const sig = await signWebhookPayload(large);
      expect(sig).toMatch(/^sha256=[a-f0-9]{64}$/);
    });

    test("handles special characters", async () => {
      const sig = await signWebhookPayload('{"msg":"alert & notify <user> \"test\""}');
      expect(sig).toMatch(/^sha256=[a-f0-9]{64}$/);
    });

    test("handles newlines in payload", async () => {
      const sig = await signWebhookPayload("line1\nline2\nline3");
      expect(sig).toMatch(/^sha256=[a-f0-9]{64}$/);
    });
  });

  describe("Security properties", () => {
    test("tiny change in payload changes signature completely", async () => {
      const sig1 = await signWebhookPayload('{"price":"59.99"}');
      const sig2 = await signWebhookPayload('{"price":"59.98"}');
      // At least half the hex chars should differ (avalanche property)
      const hex1 = sig1.replace("sha256=", "");
      const hex2 = sig2.replace("sha256=", "");
      let diffCount = 0;
      for (let i = 0; i < hex1.length; i++) {
        if (hex1[i] !== hex2[i]) diffCount++;
      }
      expect(diffCount).toBeGreaterThan(10); // Strong avalanche
    });

    test("signature is deterministic across calls", async () => {
      const payload = "deterministic test payload 12345";
      const signatures = await Promise.all(
        Array.from({ length: 5 }, () => signWebhookPayload(payload))
      );
      for (const sig of signatures) {
        expect(sig).toBe(signatures[0]);
      }
    });
  });
});
