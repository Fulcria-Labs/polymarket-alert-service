# Polymarket Alert Service

**Chainlink Convergence Hackathon 2026 - AI Agents + Prediction Markets Track**

A prediction market monitoring service that combines Chainlink CRE workflows with x402 micropayments, enabling users to subscribe to custom alerts for prediction market conditions.

## Demo

[![Demo Video](https://img.shields.io/badge/Watch-Demo-red)](https://asciinema.org/a/SYej79kvhGWSiN6R)

**Live Terminal Demo:** https://asciinema.org/a/SYej79kvhGWSiN6R

![Demo GIF](demo.gif)

## Features

- **Advanced Natural Language Parsing**: Understands diverse phrasings
  - "Alert me when Trump election odds exceed 60%"
  - "Notify if recession probability drops below 30%"
  - "Watch Bitcoin ETF approval at 70 cents"
  - "Trump > 70%" (shorthand)
- **Multi-Condition Alerts**: "Alert when Trump > 60% AND Biden < 40%"
- **Smart Keyword Extraction**: Automatically finds relevant markets from your query
- **x402 Micropayments**: Pay $0.01 USDC per alert subscription on Base
- **Bulk Discounts**: 10% off for 5+ alerts, 20% off for 10+ alerts
- **Real-Time Monitoring**: CRE workflow checks markets every 5 minutes
- **Price History Tracking**: CRE builds market price history over time
- **Trend Detection**: Momentum-based alerts (surging, trending, stable)
- **Portfolio Tracking**: Multi-market watchlists with weighted performance
- **Correlation Analysis**: Pearson correlation matrix between markets
- **Divergence Detection**: Alerts when correlated markets diverge
- **Arbitrage Detection**: Single-market & cross-market mispricing scanner
- **Webhook Notifications**: Get notified when your conditions are met
- **Market Search**: Find prediction markets by keyword

## Quick Start

```bash
# Install dependencies
bun install

# Run unit tests (1983 tests across 30 suites)
bun test

# Run integration test
bun run index.ts --test

# Start API server (dashboard at http://localhost:3000)
bun run index.ts
```

## Web Dashboard

The service includes a built-in web dashboard at `/` that provides:
- **Market Search** - Search Polymarket for active prediction markets
- **NLP Alert Creation** - Create alerts using natural language with the x402 payment flow
- **Trend Visualization** - Click any market to see real-time trend analysis and momentum
- **Alert Management** - View and monitor all active alerts

![Dashboard](public/screenshot.png)

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/markets/search?q=election` | GET | Search prediction markets |
| `/markets/:id` | GET | Get market details |
| `/markets/:id/history?hours=24` | GET | Price history (CRE-tracked) |
| `/markets/:id/trend?outcome=Yes` | GET | Trend analysis & momentum |
| `/alerts` | POST | Create alert (x402 payment required) |
| `/alerts` | GET | List your alerts |
| `/payment-info` | GET | Payment instructions |
| `/pricing?count=10` | GET | Calculate bulk pricing |
| `/portfolios` | POST | Create portfolio watchlist |
| `/portfolios` | GET | List portfolios |
| `/portfolios/:id` | GET | Portfolio performance |
| `/portfolios/:id` | DELETE | Delete portfolio |
| `/correlation?markets=m1,m2` | GET | Correlation matrix |
| `/divergences?markets=m1,m2` | GET | Divergence detection |
| `/arbitrage/scan` | POST | Scan for arbitrage opportunities |

## Creating an Alert

### 1. Search for a Market

```bash
curl http://localhost:3000/markets/search?q=trump
```

### 2. Create Alert (Triggers 402 Payment)

**Simple Alert:**
```bash
curl -X POST http://localhost:3000/alerts \
  -H "Content-Type: application/json" \
  -d '{
    "naturalLanguage": "Alert me when Trump odds exceed 60%",
    "notifyUrl": "https://your-webhook.com/alerts"
  }'
```

**Multi-Condition Alert:**
```bash
curl -X POST http://localhost:3000/alerts \
  -H "Content-Type: application/json" \
  -d '{
    "naturalLanguage": "Alert when Trump > 60% AND recession < 30%",
    "notifyUrl": "https://your-webhook.com/alerts"
  }'
```

### Supported Phrasings

| Pattern | Example |
|---------|---------|
| Percentage | "when Trump exceeds 60%" |
| Cents (Polymarket style) | "hits 70 cents" |
| Comparisons | "Trump > 65%" |
| Direction keywords | "drops below", "rises above", "falls under" |
| Multi-condition | "Trump > 60% AND Biden < 40%" |
| Outcome detection | "No hits 40%" (detects No outcome) |

Response (402 Payment Required):
```json
{
  "version": "1.0",
  "network": "base",
  "chainId": 8453,
  "payTo": "0x8Da63b5f30e603E2D11a924C3976F67E63035cF0",
  "maxAmountRequired": "10000",
  "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
}
```

### 3. Pay and Submit Proof

```bash
curl -X POST http://localhost:3000/alerts \
  -H "Content-Type: application/json" \
  -H "X-Payment-Proof: {\"transactionHash\":\"0x...\",\"blockNumber\":123,\"chainId\":8453,\"payer\":\"0x...\",\"amount\":\"10000\"}" \
  -d '{
    "marketId": "...",
    "outcome": "Yes",
    "threshold": 60,
    "direction": "above",
    "notifyUrl": "https://your-webhook.com/alerts"
  }'
```

## Payment Details

- **Network**: Base (Chain ID: 8453)
- **Token**: USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`)
- **Amount**: 0.01 USDC (10000 wei)
- **Receiver**: `0x8Da63b5f30e603E2D11a924C3976F67E63035cF0`

### Bulk Discounts

| Alerts | Discount |
|--------|----------|
| 5+ | 10% off |
| 10+ | 20% off |

## Architecture

```
┌──────────────┐     ┌─────────────┐     ┌──────────────┐
│   User/Bot   │────▶│  API Server │────▶│  Polymarket  │
│              │◀────│  (Hono)     │◀────│  CLOB API    │
└──────────────┘     └─────────────┘     └──────────────┘
       │                    │
       │ x402               │ CRE Workflow
       ▼                    ▼
┌──────────────┐     ┌─────────────┐
│   Base L2    │     │  Chainlink  │
│   (USDC)     │     │  Runtime    │
└──────────────┘     └─────────────┘
```

## Technologies

- **Runtime**: Bun
- **API Framework**: Hono
- **Blockchain**: Ethers.js, Base
- **Workflow**: Chainlink CRE SDK
- **Payments**: x402 Protocol

## Files

```
├── index.ts                          # Entry point
├── public/
│   └── index.html                    # Web dashboard
├── src/
│   ├── api.ts                        # Hono API routes
│   ├── polymarket-alert-workflow.ts  # CRE workflow
│   ├── portfolio.ts                  # Portfolio & arbitrage
│   └── x402-handler.ts               # Payment handling
└── package.json
```

## Environment Variables

```bash
PORT=3000                    # API server port
BASE_RPC_URL=               # Base RPC endpoint
PAYMENT_RECEIVER=           # USDC receiver address
```

## Trend Detection

The service tracks market prices over time via CRE's scheduled execution, enabling trend-based alerts in addition to simple threshold alerts.

### Get Market Trend

```bash
curl http://localhost:3000/markets/0x1234/trend?outcome=Yes
```

Response:
```json
{
  "marketId": "0x1234",
  "trend": {
    "outcome": "Yes",
    "currentPrice": 65.0,
    "changePercent1h": 8.5,
    "changePercent6h": 15.2,
    "changePercent24h": 22.0,
    "momentum": "surging_up",
    "volatility": 3.2,
    "dataPoints": 48
  }
}
```

### Momentum Labels

| Label | 1h Change |
|-------|-----------|
| `surging_up` | >= +5% |
| `trending_up` | +2% to +5% |
| `stable` | -2% to +2% |
| `trending_down` | -5% to -2% |
| `surging_down` | <= -5% |

### Create Trend Alert

```bash
curl -X POST http://localhost:3000/alerts \
  -H "Content-Type: application/json" \
  -H "X-Payment-Proof: ..." \
  -d '{
    "marketId": "0x...",
    "outcome": "Yes",
    "notifyUrl": "https://your-webhook.com/alerts",
    "type": "trend",
    "trendDirection": "up",
    "trendMinChange": 5,
    "trendWindow": 3600000
  }'
```

## Portfolio & Arbitrage

### Create Portfolio

```bash
curl -X POST http://localhost:3000/portfolios \
  -H "Content-Type: application/json" \
  -d '{
    "id": "election",
    "name": "Election Portfolio",
    "markets": [
      {"marketId": "0x1234", "label": "Trump", "outcome": "Yes", "weight": 0.5},
      {"marketId": "0x5678", "label": "Senate", "outcome": "Yes", "weight": 0.5}
    ]
  }'
```

### Correlation Analysis

```bash
curl "http://localhost:3000/correlation?markets=0x1234,0x5678,0x9abc"
```

Returns NxN Pearson correlation matrix with significance labels (strong_positive, moderate_negative, etc.)

### Arbitrage Scanner

```bash
curl -X POST http://localhost:3000/arbitrage/scan \
  -H "Content-Type: application/json" \
  -d '{
    "markets": [
      {"id": "0x1234", "question": "Will X?", "outcomes": [{"name":"Yes","price":70},{"name":"No","price":50}]}
    ]
  }'
```

Detects overpriced/underpriced markets where outcome prices don't sum to ~100%.

## Future Enhancements

- [ ] Integration with AI models for smarter NLP parsing
- [ ] Cross-chain payment support
- [ ] Telegram/Discord notification integrations

## Author

**Optimus Agent** (Fulcria Labs)
An autonomous AI agent participating in the Chainlink Convergence Hackathon 2026.

## License

MIT
