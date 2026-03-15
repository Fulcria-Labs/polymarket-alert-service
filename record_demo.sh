#!/bin/bash
# Comprehensive demo recording for Chainlink Convergence Hackathon
# Records a full walkthrough of the Polymarket Alert Service

export PATH="$HOME/.bun/bin:/usr/bin:/usr/local/bin:$PATH"
export PORT=3099
cd "$(dirname "$0")"

echo "=== Polymarket Alert Service - Full Demo ==="
echo ""
echo "Prediction market monitoring with Chainlink CRE + x402"
echo ""
sleep 2

# Step 1: Run tests
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Step 1: Run the test suite (2259 tests)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
bun test --summary 2>&1 | grep -E "pass|fail|expect|Ran"
echo ""
sleep 2

# Step 2: Integration test
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Step 2: Integration test with live Polymarket API"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
bun run index.ts --test 2>&1
echo ""
sleep 2

# Step 3: Start server in background
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Step 3: Start the API server"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
bun run index.ts &
SERVER_PID=$!
sleep 3

# Step 4: Health check
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Step 4: API Health Check"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo '$ curl http://localhost:3099/health'
curl -s http://localhost:3099/health | jq .
echo ""
sleep 2

# Step 5: Market search
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Step 5: Search Polymarket for prediction markets"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo '$ curl "http://localhost:3099/markets/search?q=trump"'
RESULT=$(curl -s "http://localhost:3099/markets/search?q=trump")
echo "$RESULT" | jq '.[0:2] | .[] | {question, yes_price: (.tokens[0].price // "N/A"), no_price: (.tokens[1].price // "N/A")}' 2>/dev/null || echo "$RESULT" | jq '.[0:2]' 2>/dev/null || echo "$RESULT"
echo ""
sleep 2

# Step 6: NLP Alert creation with x402
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Step 6: Natural language alert + x402 payment"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo '$ curl -X POST http://localhost:3099/alerts \'
echo '  -d {"naturalLanguage": "Alert when Trump odds exceed 60%"}'
echo ""
curl -s -X POST http://localhost:3099/alerts \
  -H "Content-Type: application/json" \
  -d '{"naturalLanguage": "Alert me when Trump odds exceed 60%", "notifyUrl": "https://webhook.site/test"}' \
  | jq .
echo ""
sleep 2

# Step 7: Payment info
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Step 7: x402 Payment Protocol Details"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo '$ curl http://localhost:3099/payment-info'
curl -s http://localhost:3099/payment-info | jq .
echo ""
sleep 2

# Step 8: Bulk pricing
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Step 8: Bulk Pricing with Volume Discounts"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo '$ curl "http://localhost:3099/pricing?count=10"'
curl -s "http://localhost:3099/pricing?count=10" | jq .
echo ""
sleep 2

# Step 9: Multi-condition alert
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Step 9: Multi-Condition Alert (AND logic)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo '$ curl -X POST http://localhost:3099/alerts \'
echo '  -d {"naturalLanguage": "Trump > 60% AND recession < 30%"}'
echo ""
curl -s -X POST http://localhost:3099/alerts \
  -H "Content-Type: application/json" \
  -d '{"naturalLanguage": "Alert when Trump > 60% AND recession < 30%", "notifyUrl": "https://webhook.site/test"}' \
  | jq .
echo ""
sleep 2

# Step 10: List alerts
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Step 10: View All Active Alerts"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo '$ curl http://localhost:3099/alerts'
curl -s http://localhost:3099/alerts | jq .
echo ""
sleep 2

# Cleanup
kill $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Demo Complete!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Key Technologies:"
echo "  - Chainlink CRE workflow for market monitoring"
echo "  - x402 micropayments (0.01 USDC/alert on Base)"
echo "  - NLP parsing for natural language conditions"
echo "  - Multi-condition AND logic"
echo "  - Bulk pricing with volume discounts"
echo "  - Real-time webhook notifications"
echo "  - 2259 tests across 35 suites"
echo ""
echo "github.com/optimus-fulcria/chainlink-convergence-hackathon"
sleep 3
