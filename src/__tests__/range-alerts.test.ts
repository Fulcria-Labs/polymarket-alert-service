import { test, expect, describe } from 'bun:test';
import { parseAlertRequest, parseMultiConditionAlert } from '../polymarket-alert-workflow';

const WEBHOOK = 'https://example.com/webhook';

describe('Range Alert Parsing', () => {
  test('parses "between X and Y%" format', () => {
    const result = parseAlertRequest('Trump between 40% and 60%', WEBHOOK);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('between');
    expect(result!.threshold).toBe(40);
    expect(result!.thresholdUpper).toBe(60);
    expect(result!.type).toBe('range');
  });

  test('parses "between X and Y" without percent sign', () => {
    const result = parseAlertRequest('election odds between 30 and 70', WEBHOOK);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('between');
    expect(result!.threshold).toBe(30);
    expect(result!.thresholdUpper).toBe(70);
  });

  test('parses "in range X to Y%" format', () => {
    const result = parseAlertRequest('Bitcoin ETF in range 45% to 55%', WEBHOOK);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('between');
    expect(result!.threshold).toBe(45);
    expect(result!.thresholdUpper).toBe(55);
  });

  test('parses "between X-Y%" with dash separator', () => {
    const result = parseAlertRequest('recession between 20-40%', WEBHOOK);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('between');
    expect(result!.threshold).toBe(20);
    expect(result!.thresholdUpper).toBe(40);
  });

  test('parses "stays within X and Y%" format', () => {
    const result = parseAlertRequest('Trump stays within 55% and 65%', WEBHOOK);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('between');
    expect(result!.threshold).toBe(55);
    expect(result!.thresholdUpper).toBe(65);
  });

  test('parses "stay inside X-Y%" format', () => {
    const result = parseAlertRequest('GDP growth stays inside 40%-60%', WEBHOOK);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('between');
    expect(result!.threshold).toBe(40);
    expect(result!.thresholdUpper).toBe(60);
  });

  test('parses decimal range values', () => {
    const result = parseAlertRequest('Trump between 55.5% and 64.5%', WEBHOOK);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(55.5);
    expect(result!.thresholdUpper).toBe(64.5);
  });

  test('preserves outcome detection in range alerts', () => {
    const result = parseAlertRequest('No outcome between 30% and 50%', WEBHOOK);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe('No');
    expect(result!.direction).toBe('between');
  });

  test('sets type to range for between alerts', () => {
    const result = parseAlertRequest('Trump between 40% and 60%', WEBHOOK);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('range');
  });

  test('uses correct webhook URL', () => {
    const result = parseAlertRequest('Trump between 40% and 60%', WEBHOOK);
    expect(result).not.toBeNull();
    expect(result!.notifyUrl).toBe(WEBHOOK);
  });

  test('marketId defaults to empty (resolved via search)', () => {
    const result = parseAlertRequest('recession between 20% and 40%', WEBHOOK);
    expect(result).not.toBeNull();
    expect(result!.marketId).toBe('');
  });
});

describe('Range Alert Condition Checking', () => {
  test('range alert with lower bound at 0', () => {
    const result = parseAlertRequest('Trump between 0% and 10%', WEBHOOK);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(0);
    expect(result!.thresholdUpper).toBe(10);
  });

  test('range alert with upper bound at 100', () => {
    const result = parseAlertRequest('election between 90% and 100%', WEBHOOK);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(90);
    expect(result!.thresholdUpper).toBe(100);
  });

  test('narrow range alert', () => {
    const result = parseAlertRequest('Trump between 49% and 51%', WEBHOOK);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(49);
    expect(result!.thresholdUpper).toBe(51);
  });

  test('wide range alert', () => {
    const result = parseAlertRequest('market between 10% and 90%', WEBHOOK);
    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(10);
    expect(result!.thresholdUpper).toBe(90);
  });
});

describe('Range Alert Edge Cases', () => {
  test('standard above alert still works', () => {
    const result = parseAlertRequest('Trump > 60%', WEBHOOK);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('above');
    expect(result!.thresholdUpper).toBeUndefined();
  });

  test('standard below alert still works', () => {
    const result = parseAlertRequest('Biden < 40%', WEBHOOK);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('below');
    expect(result!.thresholdUpper).toBeUndefined();
  });

  test('"exceeds" pattern still works after range addition', () => {
    const result = parseAlertRequest('when Trump exceeds 65%', WEBHOOK);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('above');
    expect(result!.threshold).toBe(65);
  });

  test('"drops below" pattern still works after range addition', () => {
    const result = parseAlertRequest('when recession drops below 30%', WEBHOOK);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('below');
    expect(result!.threshold).toBe(30);
  });

  test('multi-condition with range using dash separator and threshold', () => {
    // Use dash separator to avoid "and" splitting conflict
    const results = parseMultiConditionAlert('Trump between 40-60% AND Biden < 30%', WEBHOOK);
    expect(results.length).toBe(2);
    expect(results[0].direction).toBe('between');
    expect(results[1].direction).toBe('below');
  });

  test('range with "percent" word instead of symbol', () => {
    const result = parseAlertRequest('Trump between 40 percent and 60 percent', WEBHOOK);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('between');
    expect(result!.threshold).toBe(40);
    expect(result!.thresholdUpper).toBe(60);
  });

  test('range with "cents" notation', () => {
    const result = parseAlertRequest('Trump between 40 cents and 60 cents', WEBHOOK);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('between');
    expect(result!.threshold).toBe(40);
    expect(result!.thresholdUpper).toBe(60);
  });

  test('range alert preserves default outcome as Yes', () => {
    const result = parseAlertRequest('election between 30% and 70%', WEBHOOK);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe('Yes');
  });

  test('standard threshold alerts unchanged by range feature', () => {
    const result = parseAlertRequest('Trump > 60%', WEBHOOK);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('above');
    expect(result!.type).toBeUndefined();
  });
});
