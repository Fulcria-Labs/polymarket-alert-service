# Chainlink Convergence Hackathon - Airtable Form Answers (Copy-Paste Ready)

**Form URL:** https://airtable.com/appgJctAaKPFkMKrW/pagPPG1kBRC0C54w6/form

---

## Project Name
Polymarket Alert Service

## Team Name
Fulcria Labs

## Team Members / Email
Eric Gaudet (agent@fulcria.com)

## Track
AI Agents + Prediction Markets

## Project Description (short)
A prediction market monitoring service that combines Chainlink CRE workflows with x402 micropayments for custom alert subscriptions.

## Project Description (detailed)
Polymarket Alert Service lets users create natural language alert subscriptions on prediction markets with x402 micropayments on Base. Users can say things like "Alert me when Trump election odds exceed 60%" and the service automatically parses the intent, finds matching markets via Polymarket's Gamma API, and sets up monitoring via a Chainlink CRE workflow that checks conditions every 5 minutes.

Key capabilities:
- **Natural Language Parsing** - Understands diverse phrasings: "Trump > 60%", "recession probability drops below 30%", multi-condition alerts
- **Chainlink CRE Integration** - 4-component workflow (fetcher → parser → analyzer → notifier) runs on-chain for decentralized monitoring
- **Chainlink Price Feeds** - AggregatorV3Interface integration for ETH, BTC, LINK, MATIC, SOL, AVAX on mainnet & Base
- **Hybrid Oracle+Market Alerts** - "Alert when BTC > $80,000 AND Bitcoin ETF approval > 70%" — combines on-chain oracle prices with prediction market odds
- **Oracle-Market Analytics** - Pearson correlation, divergence detection, TWAP computation, multi-feed aggregation
- **x402 Micropayments** - $0.01 USDC per alert via the x402 payment protocol on Base, with bulk discounts
- **Advanced Analytics** - Trend detection, correlation analysis, divergence alerts, arbitrage scanning
- **Web Dashboard** - Full-featured UI for market search, alert creation, and trend visualization

Built with Bun, TypeScript, and the Chainlink CRE SDK. 2,708 tests across 40 test suites.

## How Chainlink is Used
This project integrates multiple Chainlink products:

**Chainlink CRE** (Compute Runtime Environment) powers the core alert monitoring:
1. **Market Fetcher** - CRE component fetches live prices from Polymarket Gamma API
2. **Price Parser** - CRE component normalizes and validates market data
3. **Condition Analyzer** - CRE component evaluates user-defined alert conditions with trend analysis
4. **Alert Notifier** - CRE component triggers webhook notifications when conditions are met

The workflow runs every 5 minutes, building price history and detecting momentum changes. This is a real CRE workflow defined in `src/polymarket-alert-workflow.ts`.

**Chainlink Data Feeds** (Price Oracles) enrich prediction market monitoring:
1. **AggregatorV3Interface** - Full Chainlink price feed ABI integration for ETH/USD, BTC/USD, LINK/USD, MATIC/USD, SOL/USD, AVAX/USD on mainnet & Base
2. **Staleness Detection** - Validates feed freshness; stale/incomplete rounds flagged with confidence scoring
3. **Hybrid Alerts** - New alert type: trigger when BOTH oracle price AND market probability conditions are met (e.g., "BTC > $80k AND ETF approval > 70%")
4. **Oracle-Market Correlation** - Pearson correlation analysis between on-chain oracle prices and prediction market odds
5. **Divergence Detection** - Detects when oracle prices and market odds decouple (oracle-leading vs market-leading)
6. **TWAP** - Time-weighted average price computation across configurable windows
7. **Multi-Feed Aggregation** - Weighted average, median, TWAP across multiple oracle feeds simultaneously

## How x402 is Used
x402 payment protocol handles alert subscription fees:
- Each alert costs $0.01 USDC on Base
- Bulk discounts: 10% off for 5+ alerts, 20% off for 10+
- Payment verification before alert activation
- Standard x402 headers for seamless integration

## GitHub Repository
https://github.com/optimus-fulcria/chainlink-convergence-hackathon

## Demo Video
- MP4 (29s): included in repo as `demo.mp4`
- GIF: included in repo as `demo.gif`
- Asciinema: https://asciinema.org/a/SYej79kvhGWSiN6R

The demo shows: test suite execution, integration test, server startup, health check, market search, NLP alert creation, x402 payment flow, bulk pricing, and multi-condition alerts.

## How to Run
```bash
git clone https://github.com/optimus-fulcria/chainlink-convergence-hackathon.git
cd chainlink-convergence-hackathon
bun install
bun test          # Run 2,708 tests
bun run index.ts  # Start server + dashboard at http://localhost:3000
```

---
*Last updated: 2026-03-15*
