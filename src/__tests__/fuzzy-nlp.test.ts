/**
 * Fuzzy NLP Parsing Tests
 *
 * Tests typo-tolerant natural language parsing using Levenshtein distance.
 * Ensures the system handles common misspellings, transpositions, and
 * phonetic errors in direction keywords.
 */

import { describe, test, expect } from "bun:test";
import {
  levenshteinDistance,
  fuzzyMatch,
  fuzzyDetectDirection,
  parseAlertRequest,
} from "../polymarket-alert-workflow";

describe("Levenshtein Distance", () => {
  test("identical strings have distance 0", () => {
    expect(levenshteinDistance("above", "above")).toBe(0);
  });

  test("single character difference", () => {
    expect(levenshteinDistance("above", "abovr")).toBe(1);
  });

  test("transposition counts as 2 operations", () => {
    expect(levenshteinDistance("above", "abvoe")).toBe(2);
  });

  test("extra character", () => {
    expect(levenshteinDistance("exceed", "exceeed")).toBe(1);
  });

  test("missing character", () => {
    expect(levenshteinDistance("below", "belo")).toBe(1);
  });

  test("completely different strings", () => {
    expect(levenshteinDistance("above", "under")).toBe(5);
  });

  test("empty string vs non-empty", () => {
    expect(levenshteinDistance("", "test")).toBe(4);
  });

  test("both empty", () => {
    expect(levenshteinDistance("", "")).toBe(0);
  });

  test("case sensitive", () => {
    expect(levenshteinDistance("Above", "above")).toBe(1);
  });

  test("single character strings", () => {
    expect(levenshteinDistance("a", "b")).toBe(1);
    expect(levenshteinDistance("a", "a")).toBe(0);
  });
});

describe("Fuzzy Match", () => {
  const keywords = ["above", "below", "exceed", "drops", "hits", "reaches"];

  test("exact match returns keyword", () => {
    expect(fuzzyMatch("above", keywords)).toBe("above");
  });

  test("close typo returns match", () => {
    expect(fuzzyMatch("abovr", keywords)).toBe("above");
  });

  test("double letter typo", () => {
    expect(fuzzyMatch("exceeed", keywords)).toBe("exceed");
  });

  test("missing letter typo", () => {
    expect(fuzzyMatch("belo", keywords)).toBe("below");
  });

  test("transposition typo", () => {
    expect(fuzzyMatch("bleow", keywords)).toBe("below");
  });

  test("too far from any keyword returns null", () => {
    expect(fuzzyMatch("xyzzy", keywords, 2)).toBe(null);
  });

  test("respects max distance parameter", () => {
    expect(fuzzyMatch("abovee", keywords, 1)).toBe("above");
    expect(fuzzyMatch("abxxxx", keywords, 1)).toBe(null);
  });

  test("returns closest match when multiple are close", () => {
    const result = fuzzyMatch("hit", ["hits", "bits", "fits"]);
    expect(result).toBe("hits");
  });
});

describe("Fuzzy Direction Detection", () => {
  describe("Above direction with typos", () => {
    const aboveTypos = [
      { input: "Trump exceeed 60%", desc: "exceeed (double e)" },
      { input: "Trump abve 60%", desc: "abve (missing o)" },
      { input: "Trump abovr 60%", desc: "abovr (r instead of e)" },
      { input: "Trump exeeds 60%", desc: "exeeds (missing c)" },
      { input: "Trump surpases 60%", desc: "surpases (missing s)" },
      { input: "Trump hts 60%", desc: "hts (missing i)" },
      { input: "Trump ober 60%", desc: "ober (b instead of v)" },
    ];

    for (const { input, desc } of aboveTypos) {
      test(`detects above with typo: ${desc}`, () => {
        const result = fuzzyDetectDirection(input);
        expect(result).toBe("above");
      });
    }
  });

  describe("Below direction with typos", () => {
    const belowTypos = [
      { input: "Trump bellow 30%", desc: "bellow (double l)" },
      { input: "Trump belwo 30%", desc: "belwo (transposition)" },
      { input: "Trump undre 30%", desc: "undre (transposition)" },
      { input: "Trump drps 30%", desc: "drps (missing o)" },
      { input: "Trump blew 30%", desc: "blew (close to below)" },
    ];

    for (const { input, desc } of belowTypos) {
      test(`detects below with typo: ${desc}`, () => {
        const result = fuzzyDetectDirection(input);
        expect(result).toBe("below");
      });
    }
  });

  describe("Exact matches still work", () => {
    test("exact above", () => {
      expect(fuzzyDetectDirection("above 60%")).toBe("above");
    });

    test("exact below", () => {
      expect(fuzzyDetectDirection("below 30%")).toBe("below");
    });

    test("exact exceeds", () => {
      expect(fuzzyDetectDirection("exceeds 50%")).toBe("above");
    });

    test("exact drops", () => {
      expect(fuzzyDetectDirection("drops to 20%")).toBe("below");
    });
  });

  test("returns null for unrecognizable direction", () => {
    expect(fuzzyDetectDirection("zzzzz 60%")).toBe(null);
  });

  test("returns null for no direction words", () => {
    expect(fuzzyDetectDirection("Trump 60% election")).toBe(null);
  });
});

describe("parseAlertRequest with typos (integration)", () => {
  const url = "https://webhook.example.com/notify";

  test("parses request with typo 'exceeed'", () => {
    const result = parseAlertRequest("Trump exceeed 60%", url);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(60);
    expect(result!.direction).toBe("above");
  });

  test("parses request with typo 'bellow'", () => {
    const result = parseAlertRequest("recession bellow 30%", url);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(30);
    expect(result!.direction).toBe("below");
  });

  test("parses request with typo 'abve'", () => {
    const result = parseAlertRequest("Bitcoin abve 70%", url);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(70);
    expect(result!.direction).toBe("above");
  });

  test("parses request with typo 'undre'", () => {
    const result = parseAlertRequest("inflation undre 25%", url);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(25);
    expect(result!.direction).toBe("below");
  });

  test("parses correct request without typos (regression)", () => {
    const result = parseAlertRequest("when Trump exceeds 60%", url);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(60);
    expect(result!.direction).toBe("above");
  });

  test("parses request with multiple typos but valid structure", () => {
    const result = parseAlertRequest("Bitcoin surpases 80%", url);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(80);
    expect(result!.direction).toBe("above");
  });
});
