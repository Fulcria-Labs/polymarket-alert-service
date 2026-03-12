/**
 * Polymarket Alert Service - Chainlink CRE + x402 Integration
 *
 * A prediction market monitoring service that:
 * 1. Accepts natural language alert requests
 * 2. Processes x402 micropayments for subscription
 * 3. Monitors Polymarket odds via CRE workflow
 * 4. Sends webhook notifications when conditions are met
 *
 * Track: AI Agents + Prediction Markets (Chainlink Convergence Hackathon)
 * Author: Optimus Agent (Fulcria Labs)
 *
 * Usage:
 *   bun run index.ts          # Start API server
 *   bun run index.ts --test   # Run workflow test
 */

import { serve } from 'bun';
import app from './src/api';
import workflow, { executeWorkflow, searchMarkets, parseAlertRequest, parseMultiConditionAlert, extractSearchKeywords, initPolymarketAlertWorkflow } from './src/polymarket-alert-workflow';

const PORT = parseInt(process.env.PORT || '3000');

// Check for test mode
if (process.argv.includes('--test')) {
  console.log('Running workflow test...\n');

  // Test NLP parsing
  console.log('1. Testing natural language parsing...');
  const testCases = [
    'Alert me when Trump election odds exceed 60%',
    'Notify when Bitcoin ETF approval drops below 30%',
    'Tell me if recession probability goes above 55%',
    'Watch when No hits 40 cents on AI regulation',
    'Trump > 70%',
    'Alert when Trump > 60% AND Biden < 40%',
    'If inflation falls under 25%, let me know',
  ];

  let passed = 0;
  for (const tc of testCases) {
    const parsed = parseAlertRequest(tc, 'https://test.com');
    const multi = parseMultiConditionAlert(tc, 'https://test.com');
    const keywords = extractSearchKeywords(tc);

    if (parsed || multi.length > 0) {
      passed++;
      const result = multi.length > 1 ? `${multi.length} conditions` : `${parsed?.direction} ${parsed?.threshold}% (${parsed?.outcome})`;
      console.log(`   ✓ "${tc.substring(0, 45)}..." → ${result}`);
    } else {
      console.log(`   ✗ "${tc.substring(0, 45)}..." → FAILED`);
    }
  }
  console.log(`   Passed: ${passed}/${testCases.length}\n`);

  // Test market search
  console.log('2. Searching for election markets...');
  const markets = await searchMarkets('election');
  console.log(`   Found ${markets.length} markets`);
  if (markets.length > 0) {
    console.log(`   Example: "${markets[0].question}"`);
  }

  // Test workflow execution with sample config
  console.log('\n3. Testing workflow execution...');
  const testState = {
    alertConfigs: [{
      marketId: markets[0]?.condition_id || 'test',
      outcome: 'Yes',
      threshold: 50,
      direction: 'above' as const,
      notifyUrl: 'https://httpbin.org/post',
    }],
    lastChecked: {},
    triggeredAlerts: [],
  };

  const result = await executeWorkflow(testState);
  console.log(`   Alerts triggered: ${result.alerts.length}`);
  result.alerts.forEach(a => console.log(`   - ${a}`));

  console.log('\n✅ Test complete!');
  process.exit(0);
}

// Start server
console.log(`
╔══════════════════════════════════════════════════════════════╗
║     Polymarket Alert Service - Chainlink CRE + x402          ║
╠══════════════════════════════════════════════════════════════╣
║  Track: AI Agents + Prediction Markets                       ║
║  Hackathon: Chainlink Convergence 2026                       ║
╚══════════════════════════════════════════════════════════════╝
`);

console.log(`Starting server on port ${PORT}...`);
console.log(`\nEndpoints:`);
console.log(`  GET  /                    - Web dashboard`);
console.log(`  GET  /health              - Health check`);
console.log(`  GET  /markets/search      - Search prediction markets`);
console.log(`  GET  /markets/:id         - Get market details`);
console.log(`  GET  /markets/:id/history - Price history (CRE-tracked)`);
console.log(`  GET  /markets/:id/trend   - Trend analysis & momentum`);
console.log(`  POST /alerts              - Create alert (x402 payment)`);
console.log(`  GET  /alerts              - List alerts`);
console.log(`  GET  /payment-info        - Payment instructions`);
console.log(`  GET  /pricing             - Calculate bulk pricing`);
console.log('');

serve({
  fetch: app.fetch,
  port: PORT,
});

console.log(`🚀 Server running at http://localhost:${PORT}`);
