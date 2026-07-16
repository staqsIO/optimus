# OPT-37 — MCP/CLI tool → route-tier audit

**Date:** 2026-06-08 · **Scope:** `tools/optimus-mcp/index.js` (32 tool registrations) + `tools/optimus-cli/index.js` · **Reference:** `autobot-inbox/src/route-tiers.js` (ADR-014)

## Why this audit exists

OPT-37 introduces an **external customer token** (`source: customer_jwt`, `role: customer`) so a customer's own agent system can plug into Optimus. Before exposing the MCP/CLI to non-board principals we must confirm no tool lets a customer reach an `admin` / `ops-control` / `viewer-scoped` route.

**Primary boundary (infrastructure, P2):** the *customer authorization ceiling* in `api.js` denies any `customer_jwt` request whose route tier ∉ `{public, public-signing, org-shared}` with `403 customer-tier-not-permitted` — **always enforced**, independent of the observe/enforce tier mode. So even if a customer's MCP client somehow calls a board-only tool, the server rejects it. The tool-exposure filtering below is **defense-in-depth + UX**, not the security boundary.

## MCP tool → endpoint → tier

| Tool | Endpoint(s) | Tier | Customer-reachable? | In customer MCP set? |
|------|-------------|------|:---:|:---:|
| `optimus_health` | `GET /api/pipeline/health`, `GET /api/agents/status` | ops-control | ❌ 403 | no |
| `optimus_inbox` | `GET /api/runs` | org-shared | ✅ | no¹ |
| `optimus_drafts` | `GET /api/drafts` | viewer-scoped | ❌ 403 | no |
| `optimus_approve_draft` | `POST /api/drafts/approve` | viewer-scoped | ❌ 403 | no |
| `optimus_reject_draft` | `POST /api/drafts/reject` | viewer-scoped | ❌ 403 | no |
| `optimus_signals` | `GET /api/signals` | viewer-scoped | ❌ 403 | no |
| `optimus_campaigns` | `GET /api/campaigns` | org-shared | ✅ | no¹ |
| `optimus_campaign_detail` | `GET /api/campaigns/:id` | org-shared | ✅ | no¹ |
| `optimus_create_campaign` | `POST /api/campaigns` | org-shared | ✅ | **no²** |
| `optimus_approve_campaign` | `POST /api/campaigns/:id/approve` | org-shared | ✅ | **no²** |
| `optimus_pause_campaign` | `POST /api/campaigns/:id/pause` | org-shared | ✅ | **no²** |
| `optimus_build` | `POST /api/board/build` | ops-control | ❌ 403 | no |
| `optimus_build_status` | `GET /api/board/build` | ops-control | ❌ 403 | no |
| `optimus_intents` | `GET /api/intents` | ops-control | ❌ 403 | no |
| `optimus_approve_intent` | `POST /api/intents/:id/approve` | ops-control | ❌ 403 | no |
| `optimus_reject_intent` | `POST /api/intents/:id/reject` | ops-control | ❌ 403 | no |
| `optimus_search_kb` | `POST /api/search` | org-shared | ✅ | **yes** |
| `optimus_ingest_document` | `POST /api/ingest` | org-shared | ✅ | **yes** |
| `optimus_ingest_transcript` | `POST /api/ingest` | org-shared | ✅ | **yes** |
| `optimus_push_summary` | `POST /api/ingest` | org-shared | ✅ | **yes** |
| `optimus_ingest_artifact` | `POST /api/artifacts` | org-shared | ✅ | **yes** |
| `optimus_capture_url` | `POST /api/artifacts` | org-shared | ✅ | **yes** |
| `optimus_list_artifacts` | `GET /api/artifacts` | org-shared | ✅ | **yes** |
| `optimus_get_artifact` | `GET /api/artifacts/:id` | org-shared | ✅ | **yes** |
| `optimus_enrich_contact` | `GET /api/artifacts/enrich/contact/:id` | org-shared | ✅ | **yes** |
| `optimus_enrich_project` | `GET /api/artifacts/enrich/project/:id` | org-shared | ✅ | **yes** |
| `optimus_today` | `GET /api/drafts` + `/api/signals` + `/api/campaigns` + `/api/pipeline/health` | **mixed** (viewer + ops) | ❌ partial 403 | no |
| `optimus_wiki_compile` | `POST /api/projects/compile` | org-shared | ✅ | no¹ |
| `optimus_wiki_list` | `GET /api/projects/wiki` | org-shared | ✅ | no¹ |
| `optimus_wiki_health` | `GET /api/projects/wiki/health` | org-shared | ✅ | no¹ |
| `optimus_wiki_status` | `GET /api/projects/wiki/status` | org-shared | ✅ | no¹ |
| `optimus_wiki_lint` | `POST /api/projects/wiki/lint` | org-shared | ✅ | no¹ |
| _heartbeat (background)_ | `POST /api/agents/heartbeat` | ops-control | ❌ 403 | disabled for customers |

¹ **org-shared but internal-ops** — tier-permitted for a customer, but excluded from the customer tool set because they surface our internal pipeline (runs/campaigns/wiki). Not a security issue; a product/clarity choice.
² **org-shared write, deliberately excluded** — a customer should not be able to drive our agent org to build things. The tier *permits* it (board members legitimately use campaigns), and the issued customer token's `scope` (`kb:*`, `artifacts:*`) does **not** include campaign scope, so this is excluded at the tool layer. If hard server enforcement is later required, add a per-scope check to the campaign routes.

## Customer-safe MCP tool set (the "company brain" surface)

The 10 KB + artifact + enrichment tools matching the customer token scopes (`kb:read/write`, `artifacts:read/write`):

`optimus_search_kb`, `optimus_ingest_document`, `optimus_ingest_transcript`, `optimus_push_summary`, `optimus_ingest_artifact`, `optimus_capture_url`, `optimus_list_artifacts`, `optimus_get_artifact`, `optimus_enrich_contact`, `optimus_enrich_project`.

The MCP server detects token class from the JWT `iss` (`optimus-customer`) and registers **only** this set + disables the board-agent heartbeat. A board token registers all 32 as before.

## CLI audit (`tools/optimus-cli/index.js`)

All CLI commands already target org-shared endpoints only — `ingest`, `artifact add`, `capture`, `push-summary` → `POST /api/ingest` / `POST /api/artifacts`; `search` → `POST /api/search`; `enrich` → `GET /api/artifacts/enrich/*`; `watch`/`capture-session` wrap `artifact add` / `ingest`. **The CLI is customer-safe as-is** — no tool reaches a board-only route. No change required for tier safety.

## Verdict

- ✅ No privilege-escalation path: the server-side customer ceiling denies all `ops-control`/`admin`/`viewer-scoped` routes for customer tokens regardless of which tool is invoked.
- ✅ MCP hardened with token-class-aware exposure (defense-in-depth).
- ✅ CLI already safe.
- ⚠️ Follow-up (optional): if campaign/wiki writes must be *hard*-blocked for customers (not just tool-omitted), add per-scope enforcement on those org-shared routes. Tracked as a non-blocking note.
