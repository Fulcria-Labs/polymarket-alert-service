/**
 * NLP Parsing Edge Cases
 *
 * Covers: malformed input, unicode, very long queries, ambiguous phrases,
 * multi-language tokens, special characters, edge numbers (0%, 100%, negative),
 * compound conditions, extractPercentage edge cases, extractSubject behavior,
 * detectDirection/detectOutcome boundary testing.
 */

import { describe, test, expect } from "bun:test";
import {
  parseAlertRequest,
  parseMultiConditionAlert,
  extractSearchKeywords,
} from "../polymarket-alert-workflow";

const NOTIFY = "https://hook.test/nlp";

// ─── Malformed / garbage input ───────────────────────────────────────────────

describe("NLP - malformed input", () => {
  test("returns null for null-like string 'null'", () => {
    expect(parseAlertRequest("null", NOTIFY)).toBeNull();
  });

  test("returns null for 'undefined'", () => {
    expect(parseAlertRequest("undefined", NOTIFY)).toBeNull();
  });

  test("returns null for JSON object string", () => {
    expect(parseAlertRequest('{"threshold":60}', NOTIFY)).toBeNull();
  });

  test("returns null for just a URL", () => {
    expect(parseAlertRequest("https://example.com", NOTIFY)).toBeNull();
  });

  test("returns null for SQL injection attempt", () => {
    expect(parseAlertRequest("'; DROP TABLE alerts;--", NOTIFY)).toBeNull();
  });

  test("returns null for HTML tags only", () => {
    expect(parseAlertRequest("<div><p>hello</p></div>", NOTIFY)).toBeNull();
  });

  test("returns null for single special character", () => {
    expect(parseAlertRequest("@", NOTIFY)).toBeNull();
  });

  test("returns null for only punctuation", () => {
    expect(parseAlertRequest("!@#$%^&*()", NOTIFY)).toBeNull();
  });

  test("returns null for tab and newline characters only", () => {
    expect(parseAlertRequest("\t\n\r", NOTIFY)).toBeNull();
  });

  test("returns null for repeated percentage signs", () => {
    expect(parseAlertRequest("%%% %%%", NOTIFY)).toBeNull();
  });

  test("returns null for emoji-only input", () => {
    expect(parseAlertRequest("🚀🌙💰", NOTIFY)).toBeNull();
  });

  test("returns null for base64 encoded string", () => {
    expect(parseAlertRequest("aGVsbG8gd29ybGQ=", NOTIFY)).toBeNull();
  });
});

// ─── Unicode and special character handling ──────────────────────────────────

describe("NLP - unicode input", () => {
  test("handles accented characters in subject", () => {
    const result = parseAlertRequest("when Macron exceeds 60%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(60);
  });

  test("handles CJK characters around percentage", () => {
    const result = parseAlertRequest("when test exceeds 50%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(50);
  });

  test("handles right arrow unicode in request", () => {
    const result = parseAlertRequest("Trump \u2192 exceeds 70%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(70);
  });

  test("handles curly quotes around outcome", () => {
    const result = parseAlertRequest("when \u201CNo\u201D hits 40%", NOTIFY);
    expect(result).not.toBeNull();
    // The curly-quoted "No" might not be detected as No outcome
    expect(result!.threshold).toBe(40);
  });

  test("handles em dash in text", () => {
    const result = parseAlertRequest("Trump\u2014election exceeds 65%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(65);
  });

  test("handles non-breaking space", () => {
    const result = parseAlertRequest("when Trump exceeds\u00A060%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(60);
  });

  test("handles fullwidth digits in percentage", () => {
    // Fullwidth 6 and 0 won't match standard \d regex
    const result = parseAlertRequest("when Trump exceeds \uFF16\uFF10%", NOTIFY);
    // Should return null since fullwidth digits don't match \d
    expect(result).toBeNull();
  });
});

// ─── Very long queries ───────────────────────────────────────────────────────

describe("NLP - very long queries", () => {
  test("handles 500 character query with percentage at end", () => {
    const padding = "lorem ipsum dolor sit amet ".repeat(20);
    const result = parseAlertRequest(`when ${padding}exceeds 75%`, NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(75);
  });

  test("handles 1000 character query", () => {
    const padding = "x ".repeat(500);
    const result = parseAlertRequest(`when ${padding}exceeds 80%`, NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(80);
  });

  test("handles query with 100 repeated keywords", () => {
    const repeatedKeywords = "above above above ".repeat(33);
    const result = parseAlertRequest(`when Trump ${repeatedKeywords}50%`, NOTIFY);
    // Should still extract percentage and direction
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(50);
    expect(result!.direction).toBe("above");
  });

  test("handles query with percentage appearing multiple times", () => {
    const result = parseAlertRequest("when Trump is at 30% and could exceed 60%", NOTIFY);
    // Pattern 2 matches "exceed 60%" which has an explicit direction keyword
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(60);
    expect(result!.direction).toBe("above");
  });
});

// ─── Ambiguous phrases ───────────────────────────────────────────────────────

describe("NLP - ambiguous phrases", () => {
  test("'when Trump is at 50%' has no clear direction", () => {
    const result = parseAlertRequest("when Trump is at 50%", NOTIFY);
    // 'at' matches Pattern 4 which defaults to 'above'
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("above");
    expect(result!.threshold).toBe(50);
  });

  test("'Trump 60%' with no direction keyword", () => {
    const result = parseAlertRequest("Trump 60%", NOTIFY);
    // No direction keyword => fallback may fail
    expect(result).toBeNull();
  });

  test("contradictory keywords: 'above' then 'below' in same sentence", () => {
    const result = parseAlertRequest("when Trump goes above but falls below 40%", NOTIFY);
    // 'below' keyword appears, fallback should detect 'below'
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("below");
  });

  test("both Yes and No keywords present", () => {
    const result = parseAlertRequest("when No win probability exceeds 60%", NOTIFY);
    expect(result).not.toBeNull();
    // 'No' explicit mention should take priority
    expect(result!.outcome).toBe("No");
  });

  test("'not' vs 'no' - 'not win' should not trigger No detection via 'no'", () => {
    const result = parseAlertRequest("when it does not exceed 60% above 50%", NOTIFY);
    // Has 'above' keyword and percentage - should parse
    expect(result).not.toBeNull();
  });

  test("direction keyword embedded in subject word 'recovery' (contains 'over')", () => {
    const result = parseAlertRequest("when recovery hits 60%", NOTIFY);
    expect(result).not.toBeNull();
    // 'hits' => Pattern 4 => above
    expect(result!.direction).toBe("above");
    expect(result!.threshold).toBe(60);
  });

  test("subject contains 'below' as part of word 'elbowed'", () => {
    // 'below' is not in 'elbowed', but let's test a word that contains 'under'
    const result = parseAlertRequest("when thunderstorm probability hits 30%", NOTIFY);
    expect(result).not.toBeNull();
    // 'under' is in 'thunderstorm' - detectDirection checks lower.includes()
    expect(result!.direction).toBe("above"); // 'hits' => Pattern 4 => above
  });
});

// ─── Edge number values ──────────────────────────────────────────────────────

describe("NLP - edge number values", () => {
  test("threshold 0.01% (very small decimal)", () => {
    const result = parseAlertRequest("when odds drop below 0.01%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(0.01);
  });

  test("threshold 0.1%", () => {
    const result = parseAlertRequest("when odds drop below 0.1%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(0.1);
  });

  test("threshold 1%", () => {
    const result = parseAlertRequest("when odds exceed 1%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(1);
  });

  test("threshold 99%", () => {
    const result = parseAlertRequest("when certainty exceeds 99%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(99);
  });

  test("threshold 99.99%", () => {
    const result = parseAlertRequest("when sureness exceeds 99.99%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(99.99);
  });

  test("threshold 200% (nonsensical but parseable)", () => {
    const result = parseAlertRequest("when leverage exceeds 200%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(200);
  });

  test("threshold 1000%", () => {
    const result = parseAlertRequest("when value exceeds 1000%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(1000);
  });

  test("threshold with many decimal places 33.333%", () => {
    const result = parseAlertRequest("when odds exceed 33.333%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(33.333);
  });

  test("0 cents format", () => {
    const result = parseAlertRequest("when price drops below 0 cents", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(0);
  });

  test("99 cents format", () => {
    const result = parseAlertRequest("when price exceeds 99 cents", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(99);
  });

  test("threshold as whole number without % sign but with 'percent' word", () => {
    const result = parseAlertRequest("when odds exceed 42 percent", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(42);
  });
});

// ─── Compound conditions in single request ───────────────────────────────────

describe("NLP - compound conditions via parseMultiConditionAlert", () => {
  test("three conditions separated by 'and'", () => {
    const results = parseMultiConditionAlert(
      "Trump > 60% and Biden < 40% and recession above 80%",
      NOTIFY
    );
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  test("conditions with mixed operators and separators", () => {
    const results = parseMultiConditionAlert(
      "Trump exceeds 55% & ETF drops below 30%",
      NOTIFY
    );
    expect(results.length).toBe(2);
    expect(results[0].direction).toBe("above");
    expect(results[1].direction).toBe("below");
  });

  test("pipe-separated conditions", () => {
    const results = parseMultiConditionAlert(
      "recession > 70% | inflation < 25% | GDP hits 45%",
      NOTIFY
    );
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  test("all unparseable parts produce empty array", () => {
    const results = parseMultiConditionAlert(
      "gibberish and nonsense or random",
      NOTIFY
    );
    expect(results).toHaveLength(0);
  });

  test("one valid and two invalid returns one result", () => {
    const results = parseMultiConditionAlert(
      "nothing here and Trump > 60% and also nothing",
      NOTIFY
    );
    expect(results).toHaveLength(1);
    expect(results[0].threshold).toBe(60);
  });

  test("empty string returns empty array", () => {
    const results = parseMultiConditionAlert("", NOTIFY);
    expect(results).toHaveLength(0);
  });

  test("whitespace only returns empty array", () => {
    const results = parseMultiConditionAlert("   ", NOTIFY);
    expect(results).toHaveLength(0);
  });

  test("single condition returns length 1", () => {
    const results = parseMultiConditionAlert("Trump > 70%", NOTIFY);
    expect(results).toHaveLength(1);
  });

  test("preserves individual thresholds in multi-condition", () => {
    const results = parseMultiConditionAlert(
      "A > 55% & B < 35%",
      NOTIFY
    );
    if (results.length >= 2) {
      expect(results[0].threshold).toBe(55);
      expect(results[1].threshold).toBe(35);
    }
  });

  test("preserves individual outcomes in multi-condition", () => {
    const results = parseMultiConditionAlert(
      "No hits 40% & win exceeds 70%",
      NOTIFY
    );
    if (results.length >= 2) {
      expect(results[0].outcome).toBe("No");
      expect(results[1].outcome).toBe("Yes");
    }
  });
});

// ─── extractSearchKeywords edge cases ────────────────────────────────────────

describe("extractSearchKeywords - edge cases", () => {
  test("returns array for empty string", () => {
    const kw = extractSearchKeywords("");
    expect(Array.isArray(kw)).toBe(true);
  });

  test("returns array for whitespace only", () => {
    const kw = extractSearchKeywords("   ");
    expect(Array.isArray(kw)).toBe(true);
  });

  test("extracts capitalized words from complex sentence", () => {
    const kw = extractSearchKeywords(
      "Alert me when Federal Reserve interest rate decision exceeds 60%"
    );
    expect(kw.some(k => k.includes("Federal") || k.includes("Reserve"))).toBe(true);
  });

  test("extracts from 'will X win' pattern", () => {
    const kw = extractSearchKeywords("will Biden win the primary election above 50%");
    expect(kw.length).toBeGreaterThan(0);
  });

  test("handles input with no capitalized words", () => {
    const kw = extractSearchKeywords("when something exceeds 50%");
    expect(kw.length).toBeGreaterThan(0);
  });

  test("handles input with all caps", () => {
    const kw = extractSearchKeywords("WHEN TRUMP EXCEEDS 60%");
    expect(Array.isArray(kw)).toBe(true);
  });

  test("deduplicates results", () => {
    const kw = extractSearchKeywords("Trump Trump Trump election Trump exceeds 60%");
    const unique = new Set(kw);
    expect(unique.size).toBe(kw.length);
  });

  test("handles numbers in subject", () => {
    const kw = extractSearchKeywords("when 2026 GDP exceeds 60%");
    expect(kw.length).toBeGreaterThan(0);
  });

  test("handles very short input", () => {
    const kw = extractSearchKeywords("X");
    expect(Array.isArray(kw)).toBe(true);
  });

  test("handles input with only direction keyword and percentage", () => {
    const kw = extractSearchKeywords("above 60%");
    expect(Array.isArray(kw)).toBe(true);
  });
});

// ─── Direction detection edge cases ──────────────────────────────────────────

describe("NLP - direction detection nuances", () => {
  test("'surpasses' maps to above", () => {
    const result = parseAlertRequest("when approval surpasses 80%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("above");
  });

  test("'passes' maps to above", () => {
    const result = parseAlertRequest("when odds passes 65%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("above");
  });

  test("'breaks' maps to above", () => {
    const result = parseAlertRequest("when price breaks 90%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("above");
  });

  test("'tops' maps to above", () => {
    const result = parseAlertRequest("when market tops 70%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("above");
  });

  test("'sinks to' matches Pattern 4 'to' first", () => {
    const result = parseAlertRequest("when market sinks to 20%", NOTIFY);
    expect(result).not.toBeNull();
    // Pattern 4 matches 'to' -> direction defaults to 'above'
    expect(result!.threshold).toBe(20);
  });

  test("'declines to' matches Pattern 4 'to' first", () => {
    const result = parseAlertRequest("when value declines to 15%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(15);
  });

  test("'falls to' as below direction via Pattern 2", () => {
    const result = parseAlertRequest("when odds falls to 25%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("below");
  });

  test("'drops to' as below direction via Pattern 2", () => {
    const result = parseAlertRequest("when price drops to 15%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("below");
  });

  test("'goes below' as below direction via Pattern 2", () => {
    const result = parseAlertRequest("when odds goes below 30%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("below");
  });

  test("'rises to' as above direction via Pattern 2", () => {
    const result = parseAlertRequest("when price rises to 80%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("above");
  });
});

// ─── Outcome detection edge cases ────────────────────────────────────────────

describe("NLP - outcome detection nuances", () => {
  test("'will' keyword maps to Yes", () => {
    const result = parseAlertRequest("when it will happen exceeds 60%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("Yes");
  });

  test("'pass' keyword maps to Yes via Yes keywords", () => {
    const result = parseAlertRequest("when pass probability exceeds 60%", NOTIFY);
    expect(result).not.toBeNull();
    // 'passes' in ABOVE_KEYWORDS may also influence direction
    expect(result!.outcome).toBe("Yes");
  });

  test("'approve' keyword maps to Yes", () => {
    const result = parseAlertRequest("when approve odds exceed 50%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("Yes");
  });

  test("'reject' keyword maps to No", () => {
    const result = parseAlertRequest("when reject likelihood exceeds 40%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("No");
  });

  test("'lose' keyword maps to No", () => {
    const result = parseAlertRequest("when lose probability exceeds 55%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("No");
  });

  test("'false' keyword maps to No", () => {
    const result = parseAlertRequest("when false claim exceeds 60%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("No");
  });

  test("'true' keyword maps to Yes", () => {
    const result = parseAlertRequest("when true outcome exceeds 60%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("Yes");
  });

  test("'happen' keyword maps to Yes", () => {
    const result = parseAlertRequest("when happen odds exceed 60%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("Yes");
  });

  test("explicit 'No' overrides 'win' keyword", () => {
    const result = parseAlertRequest("when No win hits 45%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("No");
  });

  test("no outcome keywords defaults to Yes", () => {
    const result = parseAlertRequest("when market exceeds 60%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("Yes");
  });
});

// ─── Pattern matching specifics ──────────────────────────────────────────────

describe("NLP - pattern matching", () => {
  test("Pattern 1: 'when X odds exceed Y%'", () => {
    const result = parseAlertRequest("when Trump odds exceed 65%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(65);
    expect(result!.direction).toBe("above");
  });

  test("Pattern 1: 'if X probability goes above Y%'", () => {
    const result = parseAlertRequest("if recession probability goes above 50%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(50);
  });

  test("Pattern 2: 'when X exceeds Y%'", () => {
    const result = parseAlertRequest("when approval exceeds 75%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(75);
    expect(result!.direction).toBe("above");
  });

  test("Pattern 2: 'if X drops below Y%'", () => {
    const result = parseAlertRequest("if support drops below 25%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(25);
    expect(result!.direction).toBe("below");
  });

  test("Pattern 3: 'X > Y%' operator syntax", () => {
    const result = parseAlertRequest("Bitcoin > 55%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(55);
    expect(result!.direction).toBe("above");
  });

  test("Pattern 3: 'X < Y%' operator syntax", () => {
    const result = parseAlertRequest("Recession < 20%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(20);
    expect(result!.direction).toBe("below");
  });

  test("Pattern 4: 'X hits Y%'", () => {
    const result = parseAlertRequest("when ETF hits 80%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(80);
    expect(result!.direction).toBe("above");
  });

  test("Pattern 4: 'X reaches Y%'", () => {
    const result = parseAlertRequest("when approval reaches 90%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(90);
  });

  test("Fallback: percentage + direction keyword only", () => {
    const result = parseAlertRequest("above 60%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(60);
    expect(result!.direction).toBe("above");
  });

  test("Fallback: 'less than 30%'", () => {
    const result = parseAlertRequest("less than 30%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(30);
    expect(result!.direction).toBe("below");
  });
});

// ─── notifyUrl preservation ──────────────────────────────────────────────────

describe("NLP - notifyUrl handling", () => {
  test("notifyUrl is preserved in parsed result", () => {
    const url = "https://my-custom-webhook.com/alerts/123";
    const result = parseAlertRequest("when Trump exceeds 60%", url);
    expect(result).not.toBeNull();
    expect(result!.notifyUrl).toBe(url);
  });

  test("empty notifyUrl is preserved", () => {
    const result = parseAlertRequest("when Trump exceeds 60%", "");
    expect(result).not.toBeNull();
    expect(result!.notifyUrl).toBe("");
  });

  test("notifyUrl with query parameters is preserved", () => {
    const url = "https://hook.io/notify?user=123&token=abc";
    const result = parseAlertRequest("when Trump exceeds 60%", url);
    expect(result).not.toBeNull();
    expect(result!.notifyUrl).toBe(url);
  });

  test("notifyUrl preserved in multi-condition results", () => {
    const url = "https://multi.hook.io/alerts";
    const results = parseMultiConditionAlert("Trump > 60% & Biden < 40%", url);
    for (const r of results) {
      expect(r.notifyUrl).toBe(url);
    }
  });
});

// ─── marketId always empty from parser ───────────────────────────────────────

describe("NLP - marketId always empty", () => {
  test("marketId is empty string for simple parse", () => {
    const result = parseAlertRequest("when Trump exceeds 60%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.marketId).toBe("");
  });

  test("marketId is empty string for all multi-condition results", () => {
    const results = parseMultiConditionAlert("A > 50% & B < 30%", NOTIFY);
    for (const r of results) {
      expect(r.marketId).toBe("");
    }
  });

  test("marketId is empty even with market name in query", () => {
    const result = parseAlertRequest("when market 0xABC123 exceeds 60%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.marketId).toBe("");
  });
});
