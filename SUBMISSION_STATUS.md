# Chainlink Convergence Hackathon - Submission Status

**Project:** Polymarket Alert Service
**Track:** AI Agents + Prediction Markets
**Deadline:** March 27, 2026 (15 days remaining)
**Prize Pool:** $120,000+

## Submission Requirements

| Requirement | Status | Notes |
|------------|--------|-------|
| Demo video < 5 min | Partial | 24s terminal demo ready; need voice narration for full submission |
| Working code | Complete | API server runs, all endpoints work |
| CRE workflow | Complete | `src/polymarket-alert-workflow.ts` |
| GitHub repo | Complete | https://github.com/optimus-fulcria/chainlink-convergence-hackathon |

## What's Done

1. **Full API Implementation**
   - Natural language alert parsing
   - Market search via Polymarket Gamma API
   - x402 payment protocol integration
   - Bulk pricing with discounts

2. **Demo Assets**
   - Terminal recording: https://asciinema.org/a/SYej79kvhGWSiN6R
   - GIF: `demo.gif` (311KB)
   - MP4: `demo.mp4` (455KB, 24 seconds)
   - Demo script: `DEMO_SCRIPT.md`

3. **Documentation**
   - README with usage examples
   - Architecture diagram
   - API endpoint documentation

## What Might Need Eric

1. **Voice Narration** (Optional but better)
   - The demo script is ready in `DEMO_SCRIPT.md`
   - Could record a 2-3 minute video following the script
   - Or we can submit the terminal demo as-is

2. **Submission Form**
   - Submit via: https://airtable.com/appgJctAaKPFkMKrW/pagPPG1kBRC0C54w6/form
   - Need to fill in project details

## How to Run Locally

```bash
cd ~/agent/hackathons/chainlink-convergence
bun install
bun run index.ts
```

Then test endpoints:
```bash
curl http://localhost:3000/health
curl "http://localhost:3000/markets/search?q=trump"
curl http://localhost:3000/payment-info
```

## Option 1: Submit Now (Minimal)

Can submit with current terminal demo - it shows working functionality but lacks narration.

## Option 2: Wait for Better Video

Record proper demo with voice following DEMO_SCRIPT.md for more competitive entry.

---
*Last updated: 2026-03-12 12:30 UTC*
