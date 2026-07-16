# Contracts module — deployment runbook

This is the checklist for getting the Phase 1–4 + round-2 contracts build into production. Follow it in order; each item cites what breaks if you skip it.

## 0. Migrations

Apply `062` through `073` against Supabase prod in ascending order. They're additive except where explicitly noted.

```bash
# Dry run first (the migrate script should support a --plan flag; if not, diff against the last-applied migration row)
npm run migrate
```

What each migration does:

| # | Concern | Breaks if skipped |
|---|---|---|
| 062 | `content.draft_versions` + `append_draft_version()` | AI edits, autosave, revert flow all 404 against missing function |
| 063 | Attachment `content_hash`, `hash_version`, `compute_document_hash()` | `/send` fails when it tries to call the DB function |
| 064 | `content.drafts.template_id` | /new inserts fail; list queries missing column |
| 065 | `content.counterparties` + `counterparty_id` on drafts | Counterparty picker crashes; /counterparties/[id] 404s |
| 066 | `signatures.signers.last_reminded_at` | Reminder sweeper can't track rate-limit, sends duplicate emails |
| 067 | `signatures.signer_proposals` | Redline/comment submit on /sign fails |
| 068 | `rag_chunks` on draft_versions + 8-arg `append_draft_version()` | AI edits fail because function signature differs |
| 069 | `work_items_spawned_at` + `idx_work_items_contract` | Signed-contract → work_items spawn not idempotent |
| 070 | RLS on counterparties + draft_versions | None (defense-in-depth only) |
| 071 | `content.send_overrides` + immutability trigger | Block-severity sends with `override_reason` will fail to log |
| 072 | `signatures.proposal_replies` | Reply threads silently don't work |
| 073 | `contract_templates.description` + `archived_at` + touch trigger | Template authoring UI 500s on PATCH |

### Verification queries

```sql
-- All tables reachable and RLS-enabled where intended:
SELECT schemaname, tablename, rowsecurity
FROM pg_tables
WHERE schemaname IN ('content', 'signatures')
  AND tablename IN (
    'counterparties', 'draft_versions', 'send_overrides', 'contract_templates',
    'signer_proposals', 'proposal_replies'
  )
ORDER BY schemaname, tablename;

-- Hash version distribution on existing signature_requests:
SELECT hash_version, count(*) FROM signatures.signature_requests GROUP BY 1;

-- Every contract should have a counterparty_id after backfill (065):
SELECT count(*) FILTER (WHERE counterparty_id IS NULL
                        AND seo_metadata->>'client_name' IS NOT NULL) AS unlinked,
       count(*) AS total
FROM content.drafts WHERE content_type = 'contract';
```

## 1. Environment variables (Railway)

Set these on the backend service (where `src/api.js` runs):

| Var | Purpose | Consequence if missing |
|---|---|---|
| `RESEND_API_KEY` | Outbound emails (signing, reminders, signed confirmations, reply threads, completion) | All emails skip silently with a log warning. Signing still works; the counterparty never gets their link. |
| `CRON_SECRET` | Bearer token for `/api/cron/*` endpoints | Cron endpoints return 503. Reminders + expiry sweep don't fire. |
| `SIGNING_BASE_URL` | Public URL used when constructing `/sign/<token>` links in emails | Emails link to `https://board.staqs.io` default — fine if that matches prod, wrong if it's different |
| `SIGNING_FROM_EMAIL` (optional) | From-address for Resend | Defaults to `signing@umbadvisors.com` |
| `SIGNING_FROM_NAME` (optional) | From-name displayed in email clients | Defaults to `UMB Advisors` |
| `ANTHROPIC_API_KEY` | LLM calls for AI edit, commitment extraction, pre-send scan, redline reconcile | AI Bar, work_items spawn, pre-send governance, fuzzy reconcile all fail loudly |

Confirm Resend is set up with the `umbadvisors.com` domain verified, or outbound mail bounces.

## 2. Schedule the cron sweeper — GitHub Actions

The `/api/cron/signatures-sweep` endpoint is idempotent (reminders rate-limit per signer; expiry is a conditional UPDATE). Hourly cadence is right — reminder cooldown is 24h so hourly cron won't spam, and expiry check catches deadline-tipping requests.

Hosted via `.github/workflows/signatures-sweep.yml` — runs at `:05` every hour (UTC), with a manual `workflow_dispatch` trigger for on-demand sweeps after backfills. `concurrency.group` prevents overlapping runs if one tick hangs.

### Required repository secrets

Add these in GitHub → Settings → Secrets and variables → Actions:

| Secret | Value |
|---|---|
| `OPS_API_URL` | `https://preview.staqs.io` (or whichever env points at the autobot-inbox API — do NOT include a trailing slash) |
| `CRON_SECRET` | Same string you set on the Railway backend service as the `CRON_SECRET` env var. See §1. |

The workflow errors loudly if either is missing (not silent no-op). Run it manually via the Actions tab after first deploy to confirm it works.

Look for a JSON body like `{ "ok": true, "result": { "requestsExpired": 0, "signersExpired": 0, "remindersSent": 0, "remindersFailed": 0, "errors": [] } }` in the workflow log. `remindersFailed > 0` usually means Resend rejected — check `RESEND_API_KEY` and the `umbadvisors.com` domain verification status in Resend.

## 3. Chromium for PDF render — handled in the Dockerfile

`lib/contracts/pdf-render.js` uses Playwright. The autobot-inbox image is Alpine-based, where Playwright's bundled glibc Chromium won't run. The Dockerfile now:

- Sets `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` in the deps stage so `npm ci` doesn't try to download the bundled binary.
- `apk add`s the Alpine-native `chromium` package plus its runtime deps (nss, freetype, harfbuzz, ca-certificates, ttf-freefont) in the runner stage.
- Sets `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser` so Playwright uses the apk binary.

`pdf-render.js` reads that env var and passes `--no-sandbox --disable-setuid-sandbox` to Chromium (Railway containers don't have SYS_ADMIN). In local dev without the env var, Playwright falls back to its bundled browser.

No manual step required — just rebuild the Docker image. Verify after deploy:
```bash
curl -I "https://preview.staqs.io/api/ops?path=/api/contracts/<draft_id>/pdf" \
     -H "Cookie: <board session>"
# Expect: 200 application/pdf
```

## 4. Manual E2E pass

Before letting UMB operators anywhere near it:

1. **Create** a contract from a DB template (author one on `/contracts/templates` first).
2. **Edit** via the AI Bar — verify provenance sources appear in the history panel.
3. **Revert** to an earlier version via History.
4. **Approve → Send**:
   - With no block-severity findings, confirm the signing link email arrives.
   - Force a block-severity finding (ask the AI to insert "unlimited liability" somewhere) — confirm the send prompt requires an override_reason and that `content.send_overrides` records it.
5. **Sign** via the `/sign/<token>` link, in sequential mode with two signers.
6. **Mid-flight, from the signer side**, submit a redline and a comment. Confirm the board sees them, including the reply thread.
7. **Accept the redline with auto-resend**. Verify: new signing request created, old request revoked, new emails go out.
8. **Complete signing**. Verify: work_items appear on the contract detail, `contract_signed` signal row lands in `agent_graph.signals`, signed PDF arrives in both the signer's and the board creator's inbox.
9. **Verify chain** via the "Verify" link on the contract header.
10. **Download PDF** — confirm the audit trail section shows hash chain values.
11. **Run the sweeper** manually with a request whose `expires_at` is within 48h but > 0. Confirm a reminder email arrives to the right signer only (in sequential mode, only the current one).

## 5. Known follow-ups / decisions deferred

- **Agent auto-assignment of work_items.** Today they land unassigned. Wiring an agent to consume them is a governance call.
- **`contract_signed` flow.** We emit the signal; no default flow is defined. Author one in the flow builder when a downstream automation is needed.
- **File template edits still require a PR.** The 3 bundled templates live in `agents/executor-contract/*.md` and aren't editable via the templates UI by design (they ship alongside the executor-contract agent prompt).
- **`auth.uid()` semantics in RLS.** All new tables have permissive-for-authenticated policies. Application backend uses service role which bypasses RLS anyway — this is defense-in-depth only. If we ever connect a board-user Supabase auth session directly to the DB, re-evaluate.

## Rollback

All round-2 additions are additive — dropping the migrations is safe if no production data has accumulated in the new tables. For each table added between 062–073, dropping in reverse order works. `compute_document_hash()` change in 063 is the one schema-level function replacement; reverting to sha256(body)-only would flip pre-063 requests to always-tamper-detected, so don't roll 063 back if any real requests have been sent under hash_version=2.
