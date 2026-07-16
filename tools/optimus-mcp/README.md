# Optimus MCP + CLI access layer

The engagement surface for Optimus — push your work into the shared brain and query it, from Claude Code (MCP) or the terminal (CLI). Two principal classes:

- **Board members** — full tool set (pipeline, drafts, campaigns, KB, artifacts, wiki…).
- **External customers** (OPT-37) — a customer's own agent system (Cursor, bespoke) bound to **one org**, with access to the org-shared "company brain" surface only (KB ingest/search, artifact registry, enrichment).

The **Board API Gateway is the security boundary** (JWT auth, route-tier identity gate, per-org `visibleClause` scoping). The MCP/CLI are thin clients — they hold a token and call HTTP endpoints. Nothing is enforced in the client.

---

## 1. Get a token

### Board member (you)

```bash
node tools/optimus-mcp/issue-token.js <your-github-username>
# writes ~/.nemoclaw-env with OPTIMUS_TOKEN + OPTIMUS_API_URL
echo '[ -f ~/.nemoclaw-env ] && source ~/.nemoclaw-env' >> ~/.zshrc
source ~/.nemoclaw-env
```

Requires `API_SECRET` (read from `autobot-inbox/.env`). The token defaults to a **24h** board JWT scoped to your `board_members` row.

**Avoid daily re-auth:** mint a longer-lived token with `--days N` (server-capped at **90 days**):

```bash
node tools/optimus-mcp/issue-token.js <your-github-username> --days 90
```

The custom lifetime is only honored on the `API_SECRET`-gated mint route; interactive (OAuth) board logins always stay at 24h. Re-run before it expires to refresh `~/.nemoclaw-env`. After minting, the MCP picks it up on the next Claude Code launch from a shell that has `~/.nemoclaw-env` sourced (the server reads `OPTIMUS_TOKEN` at startup).

### External customer (a board admin mints it for them)

```bash
node tools/optimus-mcp/issue-customer-token.js \
  --org umb-advisors \           # tenancy org slug OR uuid
  --label "UMB — Cursor agent" \
  --as <your-github-username>     # you must belong to that org (admins: any org)
```

This creates a `customer_principals` row bound to that org and prints the customer's `OPTIMUS_TOKEN` / `OPTIMUS_API_URL`. Hand those to the customer. The token:

- is **org-scoped** — every read fail-closes to that one org (`syntheticPrincipal(org_id)`), never org-wide;
- can **only** reach `public` + `org-shared` routes — `admin` / `ops-control` / `viewer-scoped` return `403 customer-tier-not-permitted` (the *customer ceiling*, always enforced);
- carries scopes `kb:read/write`, `artifacts:read/write`.

**Revoke:**

```bash
# kill ONE token by jti, or the whole principal (all its tokens):
curl -X POST "$OPTIMUS_API_URL/api/auth/customer-token/revoke" \
  -H "Authorization: Bearer $BOARD_API_SECRET" -H "X-Board-User: <username>" \
  -H 'Content-Type: application/json' -d '{"principal_id":"<uuid>"}'
```

Deactivating the principal (`is_active=false`) kills every token it holds instantly — the verifier checks `is_active` on every request.

---

## 2. Wire up the MCP server (Claude Code)

Copy the `optimus` block from [`mcp.example.json`](./mcp.example.json) into your `.mcp.json`. **Use the relative path — not a hardcoded `/Users/...` path:**

```json
{
  "mcpServers": {
    "optimus": {
      "command": "node",
      "args": ["tools/optimus-mcp/index.js"],
      "env": { "OPTIMUS_TOKEN": "${OPTIMUS_TOKEN}", "OPTIMUS_API_URL": "${OPTIMUS_API_URL}" }
    }
  }
}
```

> **Note:** the repo-root `.mcp.json` historically hardcoded an absolute `/Users/<you>/Optimus/...` path. Replace that `args` line with the relative form above so the config is portable across machines. (This file is the agent's own runtime config, so it's edited by hand, not by tooling.)

A **customer token** is auto-detected (JWT `iss: optimus-customer`): the server registers only the 10 customer-safe tools and disables the board-agent heartbeat. No separate config needed.

### Transports

- **stdio** (default, supported) — each client runs the server locally pointed at the hosted API via `OPTIMUS_API_URL`.
- **HTTP** (experimental, OPT-37) — for hosted/on-prem deployments:
  ```bash
  OPTIMUS_MCP_TRANSPORT=http OPTIMUS_MCP_PORT=3399 node tools/optimus-mcp/index.js
  # stateless Streamable-HTTP at http://<host>:3399/mcp
  ```
  Validate against your client before relying on it. The Board API JWT is the boundary in both modes.

---

## 3. CLI (terminal) — `optimus-cli`

The non-MCP transport. Same `OPTIMUS_TOKEN`, same Board API surface, same operations as the MCP server — but a plain CLI you script with and pipe into. This is the ["MCP is dead" 80/20](https://uxplanet.org) path: tight, predictable control over *when* the call fires, *what* args go, and *how* errors surface. The MCP server, the CLI, and your own `fetch` are three transports over **one** thin HTTP layer (`client.js`); the operation set lives in `client.js` so they never drift.

```bash
export OPTIMUS_TOKEN=...        # board or customer JWT
export OPTIMUS_API_URL=https://preview.staqs.io

node tools/optimus-mcp/cli.js help                 # list commands
node tools/optimus-mcp/cli.js help ingest-doc       # per-command args
node tools/optimus-mcp/cli.js search "voicerail pricing" --limit 3
node tools/optimus-mcp/cli.js ingest-doc --title "VoiceRail PRD" --file ./prd.md
cat notes.md | node tools/optimus-mcp/cli.js push-summary --date 2026-06-08
node tools/optimus-mcp/cli.js ingest-artifact --kind prd --title "VoiceRail PRD" --file ./prd.md
node tools/optimus-mcp/cli.js capture-url https://example.com/spec --kind spec
node tools/optimus-mcp/cli.js list-artifacts --kind prd --json
node tools/optimus-mcp/cli.js get-artifact <uuid>
node tools/optimus-mcp/cli.js enrich-contact <contact-id>
```

(After `npm i -g`/`npx`, the `optimus-cli` bin replaces `node tools/optimus-mcp/cli.js`.)

- **Commands** map 1:1 to the 10 customer-safe MCP tools (`optimus-cli help <cmd>` prints the MCP-tool equivalent).
- **Content** (`raw`/`text`) comes from `--<arg>`, `--file <path>`, or **piped stdin** — in that order.
- **Output** is pretty JSON by default; `--json` prints compact JSON for piping into `jq`.
- Every command targets an **org-shared** endpoint, so the CLI is **customer-safe as-is** — a customer token works unchanged. Ownership (your user + org) is always derived server-side from the token; the CLI never sends an owner/org parameter.

> Not to be confused with `tools/optimus-cli/` (bin `optimus`) — that is the narrow Claude Code session-capture hook (`optimus capture-session`), not the customer operation surface.

---

## 4. Direct API (curl / fetch)

No client at all — the customer's agent can call the Board API directly with its `OPTIMUS_TOKEN`. This is the lowest-overhead transport and the contract the MCP server and CLI both sit on. Auth is a Bearer token; org + ownership are derived server-side; the customer ceiling enforces the org-shared scope.

```bash
# Search the company brain
curl -sX POST "$OPTIMUS_API_URL/api/search" \
  -H "Authorization: Bearer $OPTIMUS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"query":"voicerail pricing","limit":3}'

# Ingest a document (KB)
curl -sX POST "$OPTIMUS_API_URL/api/ingest" \
  -H "Authorization: Bearer $OPTIMUS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"source":"mcp-upload","title":"VoiceRail PRD","raw":"# …","format":"markdown"}'

# Route a typed artifact (registry + KB); same title = new version
curl -sX POST "$OPTIMUS_API_URL/api/artifacts" \
  -H "Authorization: Bearer $OPTIMUS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"VoiceRail PRD","kind":"prd","raw":"# …"}'

# Capture a URL as an artifact
curl -sX POST "$OPTIMUS_API_URL/api/artifacts" \
  -H "Authorization: Bearer $OPTIMUS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/spec","kind":"spec"}'

# List / get artifacts (org-scoped)
curl -s "$OPTIMUS_API_URL/api/artifacts?kind=prd&status=active" -H "Authorization: Bearer $OPTIMUS_TOKEN"
curl -s "$OPTIMUS_API_URL/api/artifacts/<uuid>"                   -H "Authorization: Bearer $OPTIMUS_TOKEN"

# Pull everything captured + linked about a contact / project
curl -s "$OPTIMUS_API_URL/api/artifacts/enrich/contact/<id>" -H "Authorization: Bearer $OPTIMUS_TOKEN"
curl -s "$OPTIMUS_API_URL/api/artifacts/enrich/project/<id>" -H "Authorization: Bearer $OPTIMUS_TOKEN"
```

| Operation | Method + path | Body / query |
|-----------|---------------|--------------|
| Search KB | `POST /api/search` | `{ query, limit? }` |
| Ingest doc | `POST /api/ingest` | `{ source:"mcp-upload", title, raw, format? }` |
| Ingest transcript | `POST /api/ingest` | `{ source:"transcript", title, raw, format? }` |
| Push summary | `POST /api/ingest` | `{ source:"daily-summary", title, raw, format:"markdown" }` |
| Ingest artifact | `POST /api/artifacts` | `{ title, kind, raw }` |
| Capture URL | `POST /api/artifacts` | `{ url, kind? }` |
| List artifacts | `GET /api/artifacts` | `?kind=&status=` |
| Get artifact | `GET /api/artifacts/:id` | — |
| Enrich contact/project | `GET /api/artifacts/enrich/{contact,project}/:id` | — |

A board-only endpoint (e.g. `POST /api/board/build`) returns `403 customer-tier-not-permitted` for a customer token — the ceiling holds regardless of transport.

---

## 5. `generate_landing_page` (chat-native demo)

A standalone MCP tool that wraps the **public** redesign generator so a teammate can produce a bespoke, intent-targeted landing page straight from a chat (Claude Desktop / Code) and get a shareable URL back. It is the feature-008 tier-3 "agent declares intent → page" MVP.

Just ask, in plain language:

> "Generate a landing page for **https://allbirds.com** targeting **waterproof rain shoes**."

The tool POSTs `{ url, visitorIntent }` to `/api/redesign/submit`, then (by default) polls `/api/redesign/status/:id` until the page is done and returns the live preview URL: `https://preview.staqs.io/api/redesign/preview/<jobId>`.

| Input | | |
|-------|---|---|
| `url` | required | The site to redesign. |
| `intent` | required | What the visitor is looking for (maps to `visitorIntent`). |
| `wait` | optional, default `true` | `true`: poll to completion (~8 min ceiling, 10s interval) and return the live `previewUrl`. `false`: return immediately with `jobId` + `statusUrl`. |

Behavior:

- **Generation is async** (~minutes, runs on the M1 runner). With `wait: true` you get the finished `previewUrl` + `costUsd`; on timeout you get `status: "generating"` and the `previewUrl` to open shortly.
- **Daily cap** (org-wide 10/24h): returns `status: "rate_limited"` — "daily generation cap reached — try again tomorrow."
- **Unsafe intent** (Model Armor inbound gate, 400): returns `status: "rejected"` — the intent was rejected as unsafe.
- **Base URL** is configurable via `OPTIMUS_API_BASE` (falls back to `OPTIMUS_API_URL`, then `https://preview.staqs.io`). No token is needed — the redesign endpoints are public + rate-limited.
- **Pre-warm tip:** re-running the **same `url` + `intent`** returns the cached page **instantly** (server-side dedup) at ~$0. Pre-warm a demo by generating once ahead of time; the live run during the demo then returns immediately.

> This tool is intentionally **not** part of the customer (`kb:*` / `artifacts:*`) operation set, so a customer token does not surface it. It is wired in `tools/optimus-mcp/generate-landing-page.js`.

---

## 6. Engagements → tailored proposals (board-only)

The engagement verbs drive the **board-workstation** flow: an engagement carries a **Living spec** that synthesizes from source documents ("proposals"), and that spec generates a **tailored client proposal**. These are board-operator routes (tier `org-shared`, viewer-scoped) — they require a **board token** and never surface to a customer token (they're not in `CUSTOMER_OPERATIONS`).

The verbs are defined once in `engagement-ops.js` (`ENGAGEMENT_OPERATIONS`) and registered in `index.js`, so the tool and its HTTP call can't drift; `autobot-inbox/test/engagement-ops.test.js` pins every method/path/body offline.

| Tool | Call | Notes |
|------|------|-------|
| `optimus_engagements` | `GET /api/engagements` | List; optional `status` filter. |
| `optimus_engagement` | `GET /api/engagements/:id` | Living spec + sections + source proposals + open conflicts. |
| `optimus_create_engagement` | `POST /api/engagements` | `{name*, client?, kind?, status?, on_behalf_of_org_id?}`. Inherits the Master spec at synth time. |
| `optimus_add_engagement_proposal` | `POST /api/engagements/:id/proposals` | Add a **source**: `paste` (`content`), `url`, or `upload` (`content_b64`+`filename`, .md/.txt/.pdf/.docx). Distinct from action proposals (`optimus_drafts`). |
| `optimus_synthesize_engagement` | `POST /api/engagements/:id/synthesize` | **Async** — returns `status:"synthesizing"`; poll `optimus_engagement` until the spec version bumps (~30–90s). `dry_run:true` returns a synchronous preview. |
| `optimus_generate_proposal` | `POST /api/engagements/:id/generate-proposal` | **The deliverable.** Master engagement → generic template; client engagement → tailored (`md`/`docx`/`gdoc`). Cached per spec version unless `force:true`. |
| `optimus_list_generated_proposals` | `GET /api/engagements/:id/generated-proposals` | Generated deliverables, newest first. |

**Typical sequence** (just ask in plain language):

1. `optimus_create_engagement` — start the engagement (or reuse an existing id from `optimus_engagements`).
2. `optimus_add_engagement_proposal` — drop in discovery-call notes, a brief, or a URL.
3. `optimus_synthesize_engagement` — rebuild the Living spec; wait for the version bump.
4. Check `optimus_engagement` for **open conflicts**; resolve before generating.
5. `optimus_generate_proposal` `{ format: "docx" }` — get the tailored client proposal.

> Ownership is derived from your token; `on_behalf_of_org_id` selects among orgs **you own** (a raw `owner_org_id` is rejected as a spoof). Synthesis and generation can incur LLM cost — `generate_proposal` is cached per spec version, so switching `format` for an unchanged spec is free.

---

## 7. Scope tiers (what a token can reach)

| Principal | iss | Reaches | Org scope |
|-----------|-----|---------|-----------|
| Board human | `optimus-board` | all tiers (admin requires board human) | own ∪ all member orgs |
| Internal agent | `optimus-agent` | authed-any tiers; org-wide (adminBypass) | trusted org-wide |
| **Customer** | `optimus-customer` | **public + org-shared only** | **its one org (fail-closed)** |

See `autobot-inbox/src/route-tiers.js` (ADR-014) for the full route→tier map and `autobot-inbox/docs/internal/opt-37-mcp-tool-tier-audit.md` for the per-tool audit.

---

## 8. Packaging (npx)

Once published as `@staqs/optimus-mcp`, clients can skip the repo checkout:

```json
{ "command": "npx", "args": ["-y", "@staqs/optimus-mcp"],
  "env": { "OPTIMUS_TOKEN": "${OPTIMUS_TOKEN}", "OPTIMUS_API_URL": "${OPTIMUS_API_URL}" } }
```
