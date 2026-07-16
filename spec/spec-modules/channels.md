# Channel Architecture (Draft)

> Proposed new SPEC module. Documents all intake channels and their reliability characteristics.
> Status: Draft — needs board review.

## Channel Matrix

| Channel | Intake | Output | Reliability | Signal Extraction |
|---------|--------|--------|-------------|-------------------|
| **Email (Gmail)** | History-based poller (60s) + reconciler safety net (5min) | Gmail drafts (L0 approval) | Medium — history API misses thread continuations | Yes (via executor-triage LLM) |
| **Linear** | Webhook → `POST /api/webhooks/linear` | Bot comments via OAuth app | Medium — comment detection fragile, HMAC fallback | Yes (via signal-ingester) |
| **Slack** | Adapter (`src/adapters/slack-adapter.js`) | Slack messages | Implemented but lightly tested | Via webhook path |
| **Telegram** | Long polling bot (`src/telegram/client.js`) | Direct messages + inline buttons | High — no webhook needed, persistent connection | No extraction (board commands only) |
| **Webhook (generic)** | `POST /api/webhooks/:source` | N/A | High — direct HTTP | Yes (via signal-ingester) |
| **Google Drive** | Folder watcher (`src/drive/watcher.js`) polls every 5min | N/A | High | Via transcript-action-extractor |

## Email Channel Details

### Inbound
- **Primary**: `pollAllAccounts()` — Gmail `history.list` API with client-side INBOX filter
- **Safety net**: `reconcileAllAccounts()` — `messages.list` query-based, runs every 5th poll cycle
- **First run**: Reconciler looks back 7 days to catch historical misses
- **Owned-email filter**: Emails FROM any `inbox.accounts` identifier are skipped (prevents processing outbound mail)

### Known Issues
- History API silently drops thread continuations — reconciler catches these
- Poller requires `sync_status != 'setup'` — new accounts must be activated via Settings
- Two Gmail accounts active: eric@staqs.io, jamie@staqs.io

### Outbound
- Drafts created in Gmail via `gmail.users.drafts.create` (L0 mode)
- Board approves via web or Telegram → draft staged → board can send from Gmail

## Linear Channel Details

### Inbound
- Webhook receives Issue and Comment events
- Comment events trigger `handleLinearComment()` which:
  1. Checks `isBoardMember()` (linearId match preferred, name fallback)
  2. Parses commands: `/retry`, `/update <text>`, `@Jamie <question>`
  3. Creates work items for agent processing
- Issue events (create, status change, label change) trigger signal ingestion

### Known Issues (Fixed 2026-03-28)
- Board members with `linearId: null` fail auth silently — backfilled Dustin's ID
- `isCommentEvent` detection required exact `type: 'Comment'` — added heuristic fallback
- Auth failures now log the userId for easy backfilling

### Outbound
- Bot comments via Linear GraphQL API (`addComment`, `addBotComment`)
- State updates via `updateIssueStateByName()` (team-aware)
- 60s cooldown per issue prevents spam

## Telegram Channel Details

### Inbound
- Long polling (no webhook, no inbound port needed)
- Only `TELEGRAM_BOARD_USER_IDS` members can interact (P1 deny by default)
- 9 commands: approve, reject, send, resolve, halt, resume, directive, status, help
- Natural language queries via `handleBoardQuery()` with LLM
- Action proposals with inline Confirm/Cancel buttons (5-minute TTL)

### Outbound
- `notifyBoard()` — broadcast to all board members
- `sendTelegramDraft()` — send approved draft content
- Service failure alerts (3x consecutive)
- Pipeline canary alerts (0 drafts with emails arriving)
- Draft ready notifications (reviewer completed)

## Reliability Tiers

| Tier | Meaning | Channels |
|------|---------|----------|
| **High** | Reliable delivery, no known silent failures | Telegram, Webhook, Drive |
| **Medium** | Works but has known edge cases requiring safety nets | Email (history gaps), Linear (auth fragility) |
| **Low** | Implemented but not battle-tested | Slack |
