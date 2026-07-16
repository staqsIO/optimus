# OPT-37 — Manual happy-path testing plan

**Goal:** validate, by hand against a running stack, that the full OPT-37 sequence actually works end-to-end. **Happy paths only** — each step is something that *should succeed* (or, for the security checks, *should cleanly deny*). If every box is ✅, the external customer access layer is live and safe.

**Date:** 2026-06-08 · **Scope:** customer token issuance → MCP/CLI auth → org-scoped reads/writes → customer ceiling → enforce mode → remote transport.

---

## 0. Setup

```bash
# From repo root
cp .env.example .env            # ensure ANTHROPIC_API_KEY + API_SECRET set
docker compose up -d            # postgres (pgvector) + redis + services
cd autobot-inbox && npm run migrate   # applies 159 (customer_principals) + 160 (enforce flip)
```

Confirm the new migrations applied:

```bash
docker compose exec postgres psql -U autobot -d autobot -c \
 "SELECT tier, mode FROM agent_graph.route_tier_modes WHERE tier IN ('admin','org-shared');"
# expect: admin=enforce, org-shared=enforce
docker compose exec postgres psql -U autobot -d autobot -c \
 "\d agent_graph.customer_principals"
# expect: table exists with org_id, label, scope, is_active...
```

Pick a known org slug for the tests:

```bash
docker compose exec postgres psql -U autobot -d autobot -c \
 "SELECT slug, name FROM tenancy.orgs WHERE is_active;"
# use e.g. 'staqs' (you must be a member) — note its uuid too
```

| # | Check | Expected | ✅ |
|---|-------|----------|----|
| 0.1 | Migrations 159 + 160 applied | both rows enforce; table present | ☐ |
| 0.2 | Unit tests green | `npm run test:ci -- test/customer-token.test.js test/route-tier-coverage.test.js` all pass | ☐ |

---

## 1. Board token still works (no regression)

```bash
node tools/optimus-mcp/issue-token.js <your-github-username>
source ~/.nemoclaw-env
curl -s "$OPTIMUS_API_URL/api/health" -H "Authorization: Bearer $OPTIMUS_TOKEN" | jq .
curl -s "$OPTIMUS_API_URL/api/artifacts" -H "Authorization: Bearer $OPTIMUS_TOKEN" | jq '.[0:2]'
```

| # | Check | Expected | ✅ |
|---|-------|----------|----|
| 1.1 | Board token minted | `~/.nemoclaw-env` written, token present | ☐ |
| 1.2 | Board hits `org-shared` (artifacts) | 200, rows from your org | ☐ |
| 1.3 | Board hits `admin` (e.g. `GET /api/customer-principals`) | 200 (you're a board human) | ☐ |

---

## 2. Mint a customer token (keystone)

```bash
node tools/optimus-mcp/issue-customer-token.js \
  --org staqs --label "Test customer agent" --as <your-github-username>
# copy the printed OPTIMUS_TOKEN into CUST_TOKEN for the next steps:
export CUST_TOKEN="<printed token>"
export OPTIMUS_API_URL="<printed url>"
```

| # | Check | Expected | ✅ |
|---|-------|----------|----|
| 2.1 | Customer principal created | prints principal id, org_id, scope `kb:*,artifacts:*`, jti | ☐ |
| 2.2 | Row exists | `SELECT id,label,is_active FROM agent_graph.customer_principals;` shows it, `is_active=t` | ☐ |
| 2.3 | JWT shape | decode payload → `iss=optimus-customer`, `org_id` set, `sub`=principal id | ☐ |
| 2.4 | Mint for an org you're NOT in | `--org umb-advisors` (if not a member) → `403 You can only mint...` | ☐ |

---

## 3. Customer token — allowed (org-shared) paths succeed

```bash
H="-H Authorization:Bearer\ $CUST_TOKEN -H Content-Type:application/json"
# write a KB doc
curl -s -X POST "$OPTIMUS_API_URL/api/ingest" -H "Authorization: Bearer $CUST_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"source":"mcp-upload","title":"Customer test doc","raw":"hello from customer","format":"markdown"}' | jq .
# write an artifact
curl -s -X POST "$OPTIMUS_API_URL/api/artifacts" -H "Authorization: Bearer $CUST_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"raw":"# Customer PRD","kind":"prd","title":"Customer PRD test"}' | jq .
# search + list
curl -s -X POST "$OPTIMUS_API_URL/api/search" -H "Authorization: Bearer $CUST_TOKEN" \
  -H 'Content-Type: application/json' -d '{"query":"customer test","limit":5}' | jq '.results|length'
curl -s "$OPTIMUS_API_URL/api/artifacts" -H "Authorization: Bearer $CUST_TOKEN" | jq 'length'
```

| # | Check | Expected | ✅ |
|---|-------|----------|----|
| 3.1 | `POST /api/ingest` | 200, write receipt (documentId), owner stamped to the org | ☐ |
| 3.2 | `POST /api/artifacts` | 200, artifactId returned | ☐ |
| 3.3 | `POST /api/search` | 200, finds the just-ingested doc (org-scoped) | ☐ |
| 3.4 | `GET /api/artifacts` | 200, only this org's artifacts | ☐ |
| 3.5 | DB ownership | the new rows carry `owner_org_id` = the staqs org uuid | ☐ |

---

## 4. Customer token — denied (ceiling) paths fail cleanly

```bash
for r in "GET /api/drafts" "GET /api/signals" "GET /api/intents" \
         "POST /api/halt" "POST /api/board/build" "GET /api/customer-principals"; do
  m=${r% *}; p=${r#* }
  echo -n "$r -> "
  curl -s -o /dev/null -w "%{http_code}\n" -X $m "$OPTIMUS_API_URL$p" \
    -H "Authorization: Bearer $CUST_TOKEN"
done
```

| # | Check | Expected | ✅ |
|---|-------|----------|----|
| 4.1 | `GET /api/drafts` (viewer-scoped) | **403** `customer-tier-not-permitted` | ☐ |
| 4.2 | `GET /api/signals` (viewer-scoped) | **403** | ☐ |
| 4.3 | `GET /api/intents` (ops-control) | **403** | ☐ |
| 4.4 | `POST /api/halt` (admin) | **403** | ☐ |
| 4.5 | `POST /api/board/build` (ops-control) | **403** | ☐ |
| 4.6 | `GET /api/customer-principals` (admin) | **403** (customer can't list principals) | ☐ |
| 4.7 | server log | each shows `[customer-ceiling] deny: ... tier=...` | ☐ |

---

## 5. Cross-tenant isolation (the leak class this all exists to prevent)

Mint a SECOND customer token for a *different* org (as a board admin), ingest a doc under each, and confirm neither can see the other's.

```bash
# as admin, mint for a second org (e.g. umb-advisors)
node tools/optimus-mcp/issue-customer-token.js --org umb-advisors --label "UMB test" --as <admin-username>
export CUST_TOKEN_B="<printed>"
# ingest a marker under B
curl -s -X POST "$OPTIMUS_API_URL/api/artifacts" -H "Authorization: Bearer $CUST_TOKEN_B" \
  -H 'Content-Type: application/json' -d '{"raw":"UMB only secret","kind":"doc","title":"UMB marker"}' | jq .
# A must NOT see B's marker
curl -s "$OPTIMUS_API_URL/api/artifacts" -H "Authorization: Bearer $CUST_TOKEN" | jq '[.[].title] | index("UMB marker")'
```

| # | Check | Expected | ✅ |
|---|-------|----------|----|
| 5.1 | A lists artifacts | does **not** include "UMB marker" → `null` from the index() | ☐ |
| 5.2 | B searches for A's doc | `POST /api/search` from B for "Customer test doc" returns 0 matches | ☐ |

---

## 6. Revocation

```bash
# get a jti and principal id from the DB or the mint output
# single-token revoke:
curl -s -X POST "$OPTIMUS_API_URL/api/auth/customer-token/revoke" \
  -H "Authorization: Bearer $OPTIMUS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"jti":"<jti from mint>"}' | jq .
curl -s -o /dev/null -w "%{http_code}\n" "$OPTIMUS_API_URL/api/artifacts" -H "Authorization: Bearer $CUST_TOKEN"
# whole-principal kill:
curl -s -X POST "$OPTIMUS_API_URL/api/auth/customer-token/revoke" \
  -H "Authorization: Bearer $OPTIMUS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"principal_id":"<principal id>"}' | jq .
```

| # | Check | Expected | ✅ |
|---|-------|----------|----|
| 6.1 | After jti revoke | that token → **401** (revoked) within seconds | ☐ |
| 6.2 | After principal deactivate | every token for that principal → **401**; row `is_active=f, revoked_at` set | ☐ |

---

## 7. MCP server — token-class-aware exposure

```bash
# board token: full tool set + heartbeat
OPTIMUS_TOKEN="<board>" node tools/optimus-mcp/index.js   # (then list tools from an MCP client)
# customer token: only the 10 safe tools, no heartbeat
OPTIMUS_TOKEN="$CUST_TOKEN" node tools/optimus-mcp/index.js
# expect stderr: "customer token detected — registered customer-safe tool set; heartbeat disabled"
```

| # | Check | Expected | ✅ |
|---|-------|----------|----|
| 7.1 | Board MCP | all ~32 tools registered; heartbeat appears in Board UI | ☐ |
| 7.2 | Customer MCP | exactly the 10 KB/artifact/enrich tools; stderr notice printed | ☐ |
| 7.3 | Customer MCP `optimus_ingest_artifact` | works (writes to the org) | ☐ |
| 7.4 | Customer MCP — no `optimus_drafts`/`optimus_health` listed | confirmed absent | ☐ |

---

## 8. CLI — customer-safe as-is

```bash
OPTIMUS_TOKEN="$CUST_TOKEN" node tools/optimus-cli/index.js artifact add \
  --kind doc --title "CLI customer test" <(echo "from the cli")
OPTIMUS_TOKEN="$CUST_TOKEN" node tools/optimus-cli/index.js search "cli customer"
```

| # | Check | Expected | ✅ |
|---|-------|----------|----|
| 8.1 | CLI `artifact add` with customer token | 200, write receipt | ☐ |
| 8.2 | CLI `search` with customer token | 200, finds it | ☐ |

---

## 9. Enforce-mode behavior (migration 160)

```bash
# admin tier now hard-denies a bare API_SECRET WITHOUT x-board-user:
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$OPTIMUS_API_URL/api/halt" \
  -H "Authorization: Bearer $API_SECRET"
# org-shared now hard-denies unauthenticated:
curl -s -o /dev/null -w "%{http_code}\n" "$OPTIMUS_API_URL/api/artifacts"
```

| # | Check | Expected | ✅ |
|---|-------|----------|----|
| 9.1 | Bare API_SECRET (no x-board-user) on admin route | **403** `board-only:bare-api-secret` | ☐ |
| 9.2 | Same secret WITH `-H "X-Board-User: <username>"` | 200 (board human resolved) | ☐ |
| 9.3 | Unauthenticated on org-shared | **401** | ☐ |
| 9.4 | Hot rollback works | `UPDATE route_tier_modes SET mode='observe' WHERE tier='admin';` → 9.1 stops denying within ~30s | ☐ |

---

## 10. (Experimental) Remote HTTP transport

```bash
OPTIMUS_MCP_TRANSPORT=http OPTIMUS_MCP_PORT=3399 OPTIMUS_TOKEN="$CUST_TOKEN" \
  node tools/optimus-mcp/index.js &
curl -s -X POST "http://localhost:3399/mcp" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | head -c 400
```

| # | Check | Expected | ✅ |
|---|-------|----------|----|
| 10.1 | HTTP transport boots | stderr: `Streamable-HTTP transport listening on :3399/mcp` | ☐ |
| 10.2 | `tools/list` over HTTP | returns the customer-safe tool set | ☐ |

> Marked experimental — if 10.x fails, fall back to stdio (the supported path) and file a follow-up; it does not block the rest of OPT-37.

---

## Sign-off

| Section | Owner | Result |
|---------|-------|--------|
| 1 board no-regression | | |
| 2–3 customer mint + allowed | | |
| 4 customer ceiling deny | | |
| 5 cross-tenant isolation | | |
| 6 revocation | | |
| 7–8 MCP/CLI exposure | | |
| 9 enforce mode | | |
| 10 remote transport (exp.) | | |

**The critical gates are §4 (ceiling), §5 (isolation), §6 (revocation).** If those three are ✅, external customer access is safe to expose.
