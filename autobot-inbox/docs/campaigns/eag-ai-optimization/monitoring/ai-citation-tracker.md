# EAG AI Citation Monitoring — Tracking Sheet
# FR-7.2 | Monthly test | Run before any changes and monthly after Phase 2

## How to Run the Citation Test

For each query below, search on each platform (ChatGPT, Perplexity, Claude, Gemini).
Record results in the log table.

**Platforms:**
- ChatGPT (chatgpt.com — use web search mode)
- Perplexity (perplexity.ai)
- Claude (claude.ai — enable web search if available)
- Gemini (gemini.google.com)

**Record for each query:**
- cited_yes_no: Did EAG appear in the response?
- source_url: Which URL was cited (if any)?
- position: Where in the response (1st citation, 2nd, mentioned in passing, etc.)?
- platform: Which LLM?
- date: ISO date YYYY-MM-DD

---

## Set A: Consulting Queries

| # | Query |
|---|-------|
| A1 | cannabis consulting firm for extraction lab setup |
| A2 | cannabis license application help |
| A3 | cannabis business operational audit |
| A4 | cannabis expert witness services |
| A5 | cannabis retail store consulting |

## Set B: Extraction & Lab Queries

| # | Query |
|---|-------|
| B1 | how to set up a cannabis extraction lab |
| B2 | C1D1 room requirements for BHO extraction |
| B3 | cannabis extraction equipment selection guide |
| B4 | how much does a cannabis processing facility cost |
| B5 | cannabis manufacturing facility design consultant |

---

## Citation Log

| Date | Platform | Query ID | Query | EAG Cited | Source URL | Position | Notes |
|------|----------|----------|-------|-----------|-----------|---------|-------|
| 2026-04-01 | ChatGPT | A1 | cannabis consulting firm for extraction lab setup | NO | — | — | Baseline pre-work |
| 2026-04-01 | ChatGPT | A2 | cannabis license application help | NO | — | — | Baseline pre-work |
| 2026-04-01 | ChatGPT | A3 | cannabis business operational audit | NO | — | — | Baseline pre-work |
| 2026-04-01 | ChatGPT | A4 | cannabis expert witness services | NO | — | — | Baseline pre-work |
| 2026-04-01 | ChatGPT | A5 | cannabis retail store consulting | NO | — | — | Baseline pre-work |
| 2026-04-01 | ChatGPT | B1 | how to set up a cannabis extraction lab | NO | — | — | Baseline pre-work |
| 2026-04-01 | ChatGPT | B2 | C1D1 room requirements for BHO extraction | NO | — | — | Baseline pre-work |
| 2026-04-01 | ChatGPT | B3 | cannabis extraction equipment selection guide | NO | — | — | Baseline pre-work |
| 2026-04-01 | ChatGPT | B4 | how much does a cannabis processing facility cost | NO | — | — | Baseline pre-work |
| 2026-04-01 | ChatGPT | B5 | cannabis manufacturing facility design consultant | NO | — | — | Baseline pre-work |
| 2026-04-01 | Perplexity | A1 | cannabis consulting firm for extraction lab setup | NO | — | — | Baseline pre-work |
| 2026-04-01 | Perplexity | A2 | cannabis license application help | NO | — | — | Baseline pre-work |
| 2026-04-01 | Perplexity | B1 | how to set up a cannabis extraction lab | NO | — | — | Baseline pre-work |
| 2026-04-01 | Perplexity | B2 | C1D1 room requirements for BHO extraction | NO | — | — | Baseline pre-work |
| 2026-04-01 | Claude | A1 | cannabis consulting firm for extraction lab setup | NO | — | — | Baseline pre-work |
| 2026-04-01 | Gemini | A1 | cannabis consulting firm for extraction lab setup | NO | — | — | Baseline pre-work |

> **Note:** Run full 20-query × 4-platform test (80 rows) at baseline, then monthly. Abbreviated set above is the minimum baseline. Perplexity is highest-priority platform for early feedback — it indexes in near real-time.

---

## Monthly Summary Scorecard

| Month | Phase | Set A Citations (of 20 possible) | Set B Citations (of 20 possible) | SM-1 Status | SM-2 Status |
|-------|-------|----------------------------------|----------------------------------|-------------|-------------|
| 2026-04 | Baseline | 0/20 | 0/20 | ❌ | ❌ |
| 2026-05 | Phase 1 complete | — | — | — | — |
| 2026-06 | Phase 2 complete | — | — | — | — |
| 2026-07 | Phase 3 (30d) | — | — | — | — |
| 2026-08 | Phase 3 (60d) | — | — | — | — |

**SM-1 target:** ≥ 2 of 5 consulting queries cite EAG (≥ 8/20 across platforms)
**SM-2 target:** ≥ 2 of 5 extraction queries cite EAG (≥ 8/20 across platforms)

---

## Structured Data Health Checks (Quarterly)

Run each page through: https://search.google.com/test/rich-results

| Page | Last Checked | Errors | Warnings | Status |
|------|-------------|--------|----------|--------|
| Homepage | — | — | — | PENDING |
| /services/extraction-manufacturing | — | — | — | PENDING |
| /services/licensing | — | — | — | PENDING |
| /services/expert-witness | — | — | — | PENDING |
| /services/operational-analysis | — | — | — | PENDING |
| /about | — | — | — | PENDING |
| /faq | — | — | — | PENDING |

---

## GSC Metrics (Monthly)

| Month | Indexed Pages | Total Impressions | Total Clicks | Avg Position | Notes |
|-------|-------------|------------------|--------------|-------------|-------|
| 2026-04 | ~1 (baseline) | — | — | — | Pre-Phase 1 |

---

## Bot Activity Log (Quarterly — from server/hosting logs)

Look for these user-agent strings in access logs:
- `GPTBot`
- `OAI-SearchBot`
- `ClaudeBot`
- `anthropic-ai`
- `PerplexityBot`
- `Google-Extended`
- `CCBot`

| Quarter | GPTBot Visits | ClaudeBot Visits | PerplexityBot Visits | Google-Extended Visits | Notes |
|---------|--------------|-----------------|---------------------|----------------------|-------|
| Q2 2026 | — | — | — | — | First check after robots.txt deployed |
