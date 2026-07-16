# Multi-User Engineering Plan — AutoBot Inbox

> **Date:** 2026-02-28
> **Authors:** Eric, Claude (analysis)
> **Purpose:** Close the 5 blockers preventing rollout to Eric, Dustin, Mike, Bennett, Taylor
> **Lineage:** Identified by Liotta review as "the document that doesn't exist" — the actual priority gap

---

## Current State

AutoBot Inbox has **partial multi-user infrastructure**: `inbox.accounts` table exists, `pollAllAccounts()` works, AES-256-GCM credential encryption is implemented, and per-account sync state tracking is in place. But voice profiles, triage calibration, work items, briefings, and RLS are all single-user.

**Readiness by area:**

| Area | Readiness | What Exists | What's Missing |
|------|-----------|-------------|----------------|
| Gmail OAuth | 60% | Encrypted credential storage, multi-account poller, auth cache | OAuth provisioning flow, "add account" API |
| Tenant Isolation | 40% | `inbox.messages.account_id`, `inbox.drafts.account_id` | `account_id` on voice, agent_graph, signal tables; RLS by account |
| Voice Profiles | 10% | Profile builder, embedding infrastructure | `account_id` on all voice tables; per-user bootstrap |
| Triage Calibration | 5% | Static JSON rules in `config/email-rules.json` | Per-user rules stored in DB; feedback loop from user edits |
| Onboarding | 25% | `setup-gmail` script, `bootstrap-voice` script | API provisioning, guided flow, per-user settings |

---

## Blocker 1: Per-User Gmail OAuth

**Problem:** OAuth credentials live in `.env` (single user). The `getAuthForAccount()` function in `src/gmail/auth.js` already handles multi-account, but there's no way to add a new account.

**Solution:**

1. **CLI command:** `npm run add-account` — runs OAuth flow, encrypts refresh token, inserts into `inbox.accounts`
2. **API endpoint:** `POST /api/accounts` — same flow via dashboard
3. **Credential rotation:** scheduled refresh token renewal (Gmail tokens expire)

**Files to modify:**
- `scripts/setup-gmail.js` → refactor to support named accounts
- `src/api-routes/accounts.js` → new file, 2 endpoints (POST, GET /api/accounts)
- `src/gmail/auth.js` → no changes needed (already multi-account ready)

**Estimated scope:** ~150 lines new code, ~50 lines modified

---

## Blocker 2: Tenant Isolation

**Problem:** Voice, agent_graph, and signal schemas have no account dimension. RLS only checks agent identity, not user/account.

**Solution:**

New migration `sql/023-multi-user.sql`:

```sql
-- 1. Add account_id to tables that need it
ALTER TABLE voice.sent_emails ADD COLUMN account_id TEXT REFERENCES inbox.accounts(id);
ALTER TABLE voice.profiles ADD COLUMN account_id TEXT REFERENCES inbox.accounts(id);
ALTER TABLE voice.edit_deltas ADD COLUMN account_id TEXT REFERENCES inbox.accounts(id);
ALTER TABLE agent_graph.work_items ADD COLUMN account_id TEXT;
ALTER TABLE signal.contacts ADD COLUMN account_id TEXT;
ALTER TABLE signal.briefings ADD COLUMN account_id TEXT;

-- 2. Backfill existing data (single user → first account)
UPDATE voice.sent_emails SET account_id = (SELECT id FROM inbox.accounts LIMIT 1) WHERE account_id IS NULL;
-- ... same for other tables

-- 3. Make NOT NULL after backfill
ALTER TABLE voice.sent_emails ALTER COLUMN account_id SET NOT NULL;
-- ... same for other tables

-- 4. RLS policies for account isolation
CREATE POLICY account_isolation_sent_emails ON voice.sent_emails
  USING (account_id = current_setting('app.account_id', true));
-- ... same for other tables
```

**Runtime change:** `setAgentContext(client, agentId, role)` → `setAgentContext(client, agentId, role, accountId)` in `src/db.js`

**Files to modify:**
- `sql/023-multi-user.sql` → new migration
- `src/db.js` → add `app.account_id` to context setting
- All agent files → pass `account_id` through pipeline

**Estimated scope:** ~200 lines SQL, ~100 lines JS changes across 8-10 files

---

## Blocker 3: Per-User Voice Profiles

**Problem:** Voice profiles are built from sent emails with no account dimension. `buildGlobalProfile()` and `buildRecipientProfiles()` in `src/voice/profile-builder.js` aggregate all sent emails regardless of sender.

**Solution:**

1. **Schema:** Already addressed in Blocker 2 (account_id on voice tables)
2. **Profile builder:** Add `accountId` parameter to all profile functions
3. **Bootstrap per-user:** Modify `bootstrap-voice.js` to accept `--account-id` flag
4. **Draft generation:** `getProfile(recipientEmail)` → `getProfile(accountId, recipientEmail)`

**Files to modify:**
- `src/voice/profile-builder.js` → add `accountId` to all queries (~6 functions)
- `src/voice/voice-matcher.js` → scope similarity search by `account_id`
- `src/agents/executor-responder.js` → pass `accountId` from work item to voice lookup
- `scripts/bootstrap-voice.js` → accept `--account-id`, insert with account_id

**Estimated scope:** ~120 lines modified

---

## Blocker 4: Per-User Triage Calibration

**Problem:** Triage rules are global JSON (`config/email-rules.json`), not stored in the database, and not personalized. No feedback loop exists.

**Solution (phased):**

**Phase A (minimum for multi-user):**
1. Move triage rules to `inbox.triage_rules` table:
   ```sql
   CREATE TABLE inbox.triage_rules (
     id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
     account_id TEXT NOT NULL REFERENCES inbox.accounts(id),
     rule_type TEXT NOT NULL,  -- 'noise_pattern', 'fyi_pattern', 'priority_sender'
     pattern TEXT NOT NULL,
     action TEXT NOT NULL,     -- 'archive', 'label', 'prioritize'
     created_at TIMESTAMPTZ DEFAULT now()
   );
   ```
2. Seed defaults from `email-rules.json` for each new account
3. `executor-triage.js` loads rules from DB by `account_id` instead of reading JSON

**Phase B (learning, can defer to L1):**
4. Track triage overrides: when user reclassifies, record the override
5. After 50+ overrides, generate per-user rule suggestions
6. CLI/dashboard to accept/reject suggested rules

**Files to modify:**
- `sql/023-multi-user.sql` → add `inbox.triage_rules` table
- `src/agents/executor-triage.js` → load rules from DB
- `src/cli/commands/` → add `triage-rules` command for user customization

**Estimated scope:** Phase A: ~100 lines. Phase B: ~200 lines (deferrable).

---

## Blocker 5: Onboarding Flow

**Problem:** Setting up a new user requires manual database inserts, env var changes, and script runs. No guided process exists.

**Solution:**

**CLI-first onboarding** (matches P6 — familiar interfaces):

```bash
npm run onboard -- --name "Dustin" --email "dustin@example.com"
```

Steps the script automates:
1. Open browser for Gmail OAuth → receive refresh token
2. Encrypt and store credentials in `inbox.accounts`
3. Pull last 200 sent emails → build voice profile
4. Seed default triage rules from template
5. Set default autonomy level (L0)
6. Set default daily budget ($5)
7. Print summary + next steps

**Dashboard onboarding (Phase 2):**
- Settings page with "Add Account" button
- Same flow as CLI but in browser

**Files to create:**
- `scripts/onboard.js` → orchestrates the full flow (~150 lines)
- `src/api-routes/onboard.js` → dashboard API version (~80 lines)

**Estimated scope:** ~230 lines new code

---

## Implementation Order

| Order | Blocker | Dependency | Scope |
|-------|---------|------------|-------|
| 1 | **Tenant Isolation** (sql/023) | None — foundation for everything else | ~300 lines |
| 2 | **Per-User Voice** | Requires #1 | ~120 lines |
| 3 | **Per-User Triage** (Phase A) | Requires #1 | ~100 lines |
| 4 | **Gmail OAuth provisioning** | Requires #1 | ~200 lines |
| 5 | **Onboarding flow** | Requires #1-4 | ~230 lines |

**Total estimated scope:** ~950 lines across 5-7 files + 1 new migration

---

## Per-User Settings

Each account needs configurable settings. Add to `inbox.accounts` or a new `inbox.account_settings` table:

| Setting | Default | Description |
|---------|---------|-------------|
| `autonomy_level` | 0 | L0/L1/L2 per user (Eric may be L1 while Dustin is L0) |
| `daily_budget_usd` | 5.00 | LLM spend ceiling per user per day |
| `poll_interval_seconds` | 60 | How often to check this user's inbox |
| `auto_archive_noise` | false | Whether to auto-archive noise (requires L1+) |
| `timezone` | 'America/New_York' | For briefing scheduling |

---

## What This Plan Does NOT Cover

- **Multi-org / team hierarchy** — all 5 users are on one Optimus instance. Multi-org is Phase 4+.
- **Shared drafts / collaboration** — each user's drafts are private to them
- **Cross-user intelligence** — no "Dustin's contact is also Eric's contact" merging
- **Billing / metering** — all on Eric's API key for now. Per-user billing is a product feature, not an engineering blocker.
