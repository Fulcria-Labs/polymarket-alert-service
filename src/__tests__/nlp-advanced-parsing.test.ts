/**
 * NLP Advanced Parsing Tests
 *
 * Covers: typos, misspellings, abbreviations, slang, mixed casing,
 * unusual number formats, fractional thresholds, boundary percentages,
 * multi-word subjects, embedded URLs, trailing whitespace, repeated words,
 * multi-sentence inputs, question marks in input, negation detection.
 */

import { describe, test, expect } from "bun:test";
import {
  parseAlertRequest,
  parseMultiConditionAlert,
  extractSearchKeywords,
} from "../polymarket-alert-workflow";

const NOTIFY = "https://hook.test/nlp-adv";

// ─── Typos and misspellings ─────────────────────────────────────────────────

describe("NLP - typos and misspellings", () => {
  test("parses 'exceeed' with triple-e as garbage (no match)", () => {
    const result = parseAlertRequest("when Trump exceeed 60%", NOTIFY);
    // 'exceeed' won't match 'exceed' so falls to percentage+direction fallback
    // no direction keyword either, so null
    expect(result).toBeNull();
  });

  test("parses 'abov' (truncated above) - no match", () => {
    const result = parseAlertRequest("when Trump abov 60%", NOTIFY);
    expect(result).toBeNull();
  });

  test("parses correct spelling 'exceeds' with trailing space", () => {
    const result = parseAlertRequest("when Trump exceeds  60%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(60);
    expect(result!.direction).toBe("above");
  });

  test("handles 'bellow' (common misspelling of below) - no match", () => {
    const result = parseAlertRequest("when price bellow 30%", NOTIFY);
    expect(result).toBeNull();
  });

  test("handles 'aboive' typo - no match for direction", () => {
    const result = parseAlertRequest("when Bitcoin aboive 55%", NOTIFY);
    expect(result).toBeNull();
  });
});

// ─── Abbreviations and slang ────────────────────────────────────────────────

describe("NLP - abbreviations and slang", () => {
  test("parses 'BTC > 60%' with abbreviation", () => {
    const result = parseAlertRequest("BTC > 60%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("above");
    expect(result!.threshold).toBe(60);
  });

  test("parses 'ETH < 40%' with abbreviation", () => {
    const result = parseAlertRequest("ETH < 40%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("below");
    expect(result!.threshold).toBe(40);
  });

  test("parses 'SOL hits 75%' with crypto ticker", () => {
    const result = parseAlertRequest("SOL hits 75%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(75);
  });

  test("parses 'DOGE > 10%' with meme coin ticker", () => {
    const result = parseAlertRequest("DOGE > 10%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(10);
  });

  test("parses 'US election > 50%'", () => {
    const result = parseAlertRequest("US election > 50%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(50);
  });
});

// ─── Mixed casing ───────────────────────────────────────────────────────────

describe("NLP - mixed casing", () => {
  test("parses ALL CAPS 'WHEN TRUMP EXCEEDS 60%'", () => {
    const result = parseAlertRequest("WHEN TRUMP EXCEEDS 60%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(60);
    expect(result!.direction).toBe("above");
  });

  test("parses alternating case 'WhEn TrUmP ExCeEdS 60%'", () => {
    const result = parseAlertRequest("WhEn TrUmP ExCeEdS 60%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(60);
  });

  test("parses lowercase 'when bitcoin drops below 30%'", () => {
    const result = parseAlertRequest("when bitcoin drops below 30%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("below");
    expect(result!.threshold).toBe(30);
  });

  test("parses 'ALERT ME WHEN GOLD > 80%'", () => {
    const result = parseAlertRequest("ALERT ME WHEN GOLD > 80%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(80);
  });
});

// ─── Unusual number formats ────────────────────────────────────────────────

describe("NLP - unusual number formats", () => {
  test("parses decimal threshold '55.5%'", () => {
    const result = parseAlertRequest("when Trump exceeds 55.5%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(55.5);
  });

  test("parses very precise decimal '33.333%'", () => {
    const result = parseAlertRequest("when test exceeds 33.333%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBeCloseTo(33.333, 2);
  });

  test("parses single digit threshold '5%'", () => {
    const result = parseAlertRequest("when test exceeds 5%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(5);
  });

  test("parses threshold at 0%", () => {
    const result = parseAlertRequest("when test drops below 0%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(0);
  });

  test("parses threshold at 100%", () => {
    const result = parseAlertRequest("when test exceeds 100%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(100);
  });

  test("parses threshold at 99.9%", () => {
    const result = parseAlertRequest("when certainty exceeds 99.9%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(99.9);
  });

  test("parses threshold at 0.1%", () => {
    const result = parseAlertRequest("when risk drops below 0.1%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(0.1);
  });

  test("parses 'percent' word form", () => {
    const result = parseAlertRequest("when Trump exceeds 60 percent", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(60);
  });

  test("parses 'cents' format '70 cents'", () => {
    const result = parseAlertRequest("when Trump hits 70 cents", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(70);
  });
});

// ─── Boundary percentages ──────────────────────────────────────────────────

describe("NLP - boundary percentages", () => {
  test("parses threshold of 1%", () => {
    const result = parseAlertRequest("when rare event exceeds 1%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(1);
  });

  test("parses threshold of 50% (coin flip)", () => {
    const result = parseAlertRequest("when outcome exceeds 50%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(50);
  });

  test("parses threshold of 99%", () => {
    const result = parseAlertRequest("when near-certainty exceeds 99%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(99);
  });

  test("parses very small threshold 0.01%", () => {
    const result = parseAlertRequest("when micro-event drops below 0.01%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(0.01);
  });
});

// ─── Multi-word subjects ───────────────────────────────────────────────────

describe("NLP - multi-word subjects", () => {
  test("parses 'Bitcoin ETF approval exceeds 60%'", () => {
    const result = parseAlertRequest("when Bitcoin ETF approval exceeds 60%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(60);
  });

  test("parses 'Federal Reserve rate cut exceeds 70%'", () => {
    const result = parseAlertRequest("when Federal Reserve rate cut exceeds 70%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(70);
  });

  test("parses 'World War III probability drops below 5%'", () => {
    const result = parseAlertRequest("if World War III probability drops below 5%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(5);
    expect(result!.direction).toBe("below");
  });

  test("parses 'Supreme Court ruling on abortion exceeds 55%'", () => {
    const result = parseAlertRequest("when Supreme Court ruling on abortion exceeds 55%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(55);
  });
});

// ─── Trailing/leading whitespace ───────────────────────────────────────────

describe("NLP - whitespace handling", () => {
  test("parses with leading spaces", () => {
    const result = parseAlertRequest("   when Trump exceeds 60%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(60);
  });

  test("parses with trailing spaces", () => {
    const result = parseAlertRequest("when Trump exceeds 60%   ", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(60);
  });

  test("parses with multiple internal spaces", () => {
    const result = parseAlertRequest("when   Trump   exceeds   60%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(60);
  });

  test("parses with tab characters mixed with spaces", () => {
    const result = parseAlertRequest("when\tTrump\texceeds\t60%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(60);
  });
});

// ─── Direction keyword coverage ────────────────────────────────────────────

describe("NLP - direction keywords comprehensive", () => {
  test("'surpasses' maps to above", () => {
    const result = parseAlertRequest("when price surpasses 65%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("above");
  });

  test("'passes' maps to above", () => {
    const result = parseAlertRequest("when odds passes 50%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("above");
  });

  test("'breaks' maps to above", () => {
    const result = parseAlertRequest("when level breaks 70%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("above");
  });

  test("'tops' maps to above", () => {
    const result = parseAlertRequest("when market tops 80%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("above");
  });

  test("'climbs to' maps to above", () => {
    const result = parseAlertRequest("when probability climbs to 75%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("above");
  });

  test("'rises to' maps to above", () => {
    const result = parseAlertRequest("when odds rises to 60%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("above");
  });

  test("'dips to' - pattern 4 matches 'to' first, resulting in above", () => {
    // The regex patterns match "to" in "dips to" via pattern 4 before
    // the fallback direction detection can find "dips to" in BELOW_KEYWORDS
    const result = parseAlertRequest("when value dips to 25%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(25);
  });

  test("'dips below' maps to below", () => {
    const result = parseAlertRequest("when odds dips below 20%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("below");
  });

  test("'sinks to' - pattern 4 matches 'to' first", () => {
    const result = parseAlertRequest("when market sinks to 15%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(15);
  });

  test("'declines to' - pattern 4 matches 'to' first", () => {
    const result = parseAlertRequest("when probability declines to 30%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(30);
  });

  test("'less than' maps to below", () => {
    const result = parseAlertRequest("when odds less than 40%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("below");
  });

  test("'greater than' maps to above", () => {
    const result = parseAlertRequest("when odds greater than 60%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("above");
  });

  test("'more than' maps to above", () => {
    const result = parseAlertRequest("when chances more than 55%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("above");
  });

  test("'gets to' maps to above", () => {
    const result = parseAlertRequest("when price gets to 75%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("above");
  });
});

// ─── Outcome detection ─────────────────────────────────────────────────────

describe("NLP - outcome detection edge cases", () => {
  test("detects 'Yes' as default outcome", () => {
    const result = parseAlertRequest("when Trump exceeds 60%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("Yes");
  });

  test("detects 'No' outcome from 'won't' keyword", () => {
    const result = parseAlertRequest("when bill won't pass exceeds 60%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("No");
  });

  test("detects 'No' outcome from 'fail' keyword", () => {
    const result = parseAlertRequest("when policy will fail exceeds 40%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("No");
  });

  test("detects 'No' outcome from 'reject' keyword", () => {
    const result = parseAlertRequest("when voters reject measure exceeds 55%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("No");
  });

  test("detects 'No' outcome from 'lose' keyword", () => {
    const result = parseAlertRequest("when candidate will lose exceeds 70%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("No");
  });

  test("'win' keyword maps to Yes outcome", () => {
    const result = parseAlertRequest("when candidate will win exceeds 60%", NOTIFY);
    expect(result).not.toBeNull();
    // 'win' is a YES keyword, but 'No' detection checks first for 'false'/'won't' etc.
    expect(result!.outcome).toBe("Yes");
  });
});

// ─── Multi-condition parsing ───────────────────────────────────────────────

describe("NLP - multi-condition advanced", () => {
  test("splits on 'and' with two conditions", () => {
    const results = parseMultiConditionAlert("Trump > 60% and Biden < 40%", NOTIFY);
    expect(results.length).toBe(2);
    expect(results[0].threshold).toBe(60);
    expect(results[1].threshold).toBe(40);
  });

  test("splits on 'or' with two conditions", () => {
    const results = parseMultiConditionAlert("Gold > 70% or Silver < 30%", NOTIFY);
    expect(results.length).toBe(2);
  });

  test("splits on comma with spaces separator", () => {
    // Regex requires whitespace around the comma: \s+(?:,)\s+
    const results = parseMultiConditionAlert("BTC > 55% , ETH < 45%", NOTIFY);
    expect(results.length).toBe(2);
  });

  test("comma without surrounding spaces keeps as single condition", () => {
    // "55%, ETH" doesn't match the split pattern (needs \s+,\s+)
    const results = parseMultiConditionAlert("BTC > 55%, ETH < 45%", NOTIFY);
    // This is treated as a single condition because comma lacks whitespace before it
    expect(results.length).toBe(1);
  });

  test("handles three conditions with 'and'", () => {
    const results = parseMultiConditionAlert(
      "Trump > 60% and Biden < 40% and Harris > 50%",
      NOTIFY
    );
    expect(results.length).toBe(3);
  });

  test("returns single result for single condition", () => {
    const results = parseMultiConditionAlert("Trump > 60%", NOTIFY);
    expect(results.length).toBe(1);
  });

  test("returns empty array when no conditions parse", () => {
    const results = parseMultiConditionAlert("hello world and foo bar", NOTIFY);
    expect(results.length).toBe(0);
  });

  test("handles pipe separator '|'", () => {
    const results = parseMultiConditionAlert("Trump > 60% | Biden < 40%", NOTIFY);
    expect(results.length).toBe(2);
  });

  test("handles ampersand separator '&'", () => {
    const results = parseMultiConditionAlert("Gold > 70% & Silver < 30%", NOTIFY);
    expect(results.length).toBe(2);
  });
});

// ─── extractSearchKeywords edge cases ──────────────────────────────────────

describe("NLP - extractSearchKeywords edge cases", () => {
  test("extracts capitalized named entities", () => {
    const keywords = extractSearchKeywords("when Trump election exceeds 60%");
    expect(keywords.length).toBeGreaterThan(0);
    const joined = keywords.join(" ").toLowerCase();
    expect(joined).toContain("trump");
  });

  test("extracts multi-word named entity", () => {
    const keywords = extractSearchKeywords("when Bitcoin ETF approval exceeds 60%");
    expect(keywords.length).toBeGreaterThan(0);
    const joined = keywords.join(" ");
    expect(joined).toContain("Bitcoin");
  });

  test("returns fallback words for all-lowercase input", () => {
    const keywords = extractSearchKeywords("when something happens above 50%");
    expect(keywords.length).toBeGreaterThan(0);
  });

  test("handles empty string", () => {
    const keywords = extractSearchKeywords("");
    // Should return something or empty
    expect(Array.isArray(keywords)).toBe(true);
  });

  test("extracts from 'about X' pattern", () => {
    const keywords = extractSearchKeywords("alert me about gold prices");
    expect(keywords.length).toBeGreaterThan(0);
  });

  test("extracts from 'will X win' pattern", () => {
    const keywords = extractSearchKeywords("will Trump win the election");
    expect(keywords.length).toBeGreaterThan(0);
    const joined = keywords.join(" ");
    expect(joined).toContain("Trump");
  });

  test("deduplicates extracted keywords", () => {
    const keywords = extractSearchKeywords("Trump Trump Trump exceeds 60%");
    const unique = new Set(keywords);
    expect(keywords.length).toBe(unique.size);
  });

  test("handles very long input without crashing", () => {
    const longInput = "when " + "x".repeat(10000) + " exceeds 50%";
    const keywords = extractSearchKeywords(longInput);
    expect(Array.isArray(keywords)).toBe(true);
  });
});

// ─── Sentence variations ───────────────────────────────────────────────────

describe("NLP - sentence structure variations", () => {
  test("imperative: 'Alert me when Trump exceeds 60%'", () => {
    const result = parseAlertRequest("Alert me when Trump exceeds 60%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(60);
  });

  test("conditional: 'if recession probability goes above 70%'", () => {
    const result = parseAlertRequest("if recession probability goes above 70%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("above");
  });

  test("once trigger: 'once Bitcoin hits 80%'", () => {
    const result = parseAlertRequest("once Bitcoin hits 80%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(80);
  });

  test("informal: 'notify when gold > 55%'", () => {
    const result = parseAlertRequest("notify when gold > 55%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(55);
  });

  test("passive-like: 'let me know when odds drop below 20%'", () => {
    const result = parseAlertRequest("let me know when odds drop below 20%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe("below");
    expect(result!.threshold).toBe(20);
  });

  test("question-like: 'watch when silver reaches 45%'", () => {
    const result = parseAlertRequest("watch when silver reaches 45%", NOTIFY);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(45);
  });
});

// ─── notifyUrl propagation ─────────────────────────────────────────────────

describe("NLP - notifyUrl propagation", () => {
  test("parsed result carries the provided notifyUrl", () => {
    const result = parseAlertRequest("Trump > 60%", "https://my.webhook/endpoint");
    expect(result).not.toBeNull();
    expect(result!.notifyUrl).toBe("https://my.webhook/endpoint");
  });

  test("empty notifyUrl is preserved", () => {
    const result = parseAlertRequest("Trump > 60%", "");
    expect(result).not.toBeNull();
    expect(result!.notifyUrl).toBe("");
  });

  test("multi-condition preserves notifyUrl on all results", () => {
    const results = parseMultiConditionAlert("Trump > 60% and Biden < 40%", "https://hook");
    for (const r of results) {
      expect(r.notifyUrl).toBe("https://hook");
    }
  });
});
