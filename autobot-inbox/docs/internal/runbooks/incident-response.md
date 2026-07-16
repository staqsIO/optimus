---
title: "Incident Response Runbook"
description: "Severity definitions, triage flowchart, diagnostic queries, and resolution procedures for autobot-inbox failures."
---

# Incident Response Runbook

Last updated: 2026-02-28

## Severity Levels

| Severity | Definition | Examples | Target Response |
|----------|-----------|----------|-----------------|
| SEV1 | System halted, no emails processed | HALT signal active, database unreachable, all agents crashed | Immediate |
| SEV2 | Pipeline stuck, some emails not flowing | Single agent crash loop, triage backlog growing, budget exhausted | Within 1 hour |
| SEV3 | Degraded performance, slow triage | PGlite contention, slow LLM responses, cache misses | Within 4 hours |

## Triage Flowchart

When the system appears unhealthy, follow this sequence:

1. **Check API status**: `curl http://localhost:3001/api/status`
   - If connection refused: API server is down. Check if the process is running. Restart with `npm start`.
   - If response returns: proceed to step 2.

2. **Check for active HALT**: Run the halt diagnostic query below.
   - If halted: see "HALT and Resume" section.
   - If not halted: proceed to step 3.

3. **Check agent logs**: Look for `[agent-name] Fatal error` or `[reaper] Found X stuck task(s)` in stdout.
   - If agent crash loop: see "Agent Crash Loop" section.
   - If reaper activity: see "Pipeline Stuck at Triage" section.
   - If no errors: proceed to step 4.

4. **Check DB connectivity**:
   ```bash
   curl http://localhost:3001/api/debug?table=agent_graph.work_items&limit=1
   ```
   - If error response: see "Postgres Connection Failed" section.
   - If successful: proceed to step 5.

5. **Check Gmail API**:
   ```bash
   curl http://localhost:3001/api/status
   ```
   - If `gmail_connected: false`: see "Gmail Auth Expired" section.
   - If connected: proceed to step 6.

6. **Check budget**:
   ```bash
   curl http://localhost:3001/api/stats
   ```
   - Look at the `budget` array for `remaining_usd`. If zero or negative: see "Budget Exhausted" section.

## Common Failures

### Pipeline Stuck at Triage

**Symptom**: Emails arrive but triage_category stays `pending`. Work items accumulate in `created` or `assigned` state.

**Cause**: Task events are not being processed, or the executor-triage agent cannot claim tasks.

**Diagnostic**:

```sql
-- Check for unprocessed task events targeting executor-triage
SELECT event_id, event_type, work_item_id, target_agent_id, created_at
FROM agent_graph.task_events
WHERE processed_at IS NULL
  AND target_agent_id IN ('executor-triage', '*')
ORDER BY created_at DESC
LIMIT 10;

-- Check valid_transitions for the current state
SELECT * FROM agent_graph.valid_transitions
WHERE from_state = 'assigned'
  AND 'executor-triage' = ANY(allowed_roles);

-- Check guard-check failures in recent transitions
SELECT id, work_item_id, from_state, to_state, agent_id, reason
FROM agent_graph.state_transitions
WHERE agent_id = 'executor-triage'
  AND to_state = 'blocked'
ORDER BY created_at DESC
LIMIT 10;
```

**Fix**:

1. If events exist but are not processed, the executor-triage loop may have stopped. Restart the runtime.
2. If transitions show `config_hash_mismatch`, restart the runtime (config hashes are synced on startup).
3. If transitions show `can_assign_to_violation`, check that work items are assigned to `executor-triage` (not another agent). The orchestrator may have mis-routed.
4. If transitions show `halt_active`, clear the halt (see "HALT and Resume" below).

### Budget Exhausted

**Symptom**: Agents stop processing. Logs show `G1_budget_exceeded`. The event bus may fire a `halt_signal`.

**Diagnostic**:

```sql
-- Check today's budget status
SELECT id, scope, allocated_usd, spent_usd, reserved_usd,
       (allocated_usd - spent_usd - reserved_usd) AS remaining_usd
FROM agent_graph.budgets
WHERE scope = 'daily' AND period_start = CURRENT_DATE;

-- Check cost by agent today
SELECT agent_id, COUNT(*) AS calls, SUM(cost_usd) AS total_cost_usd,
       SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens
FROM agent_graph.llm_invocations
WHERE created_at >= CURRENT_DATE
GROUP BY agent_id
ORDER BY total_cost_usd DESC;
```

**Fix**:

1. Increase `DAILY_BUDGET_USD` in `.env`.
2. Update the budget row directly:
   ```sql
   UPDATE agent_graph.budgets
   SET allocated_usd = 50.00
   WHERE scope = 'daily' AND period_start = CURRENT_DATE;
   ```
3. If a halt signal was fired due to budget exhaustion, clear it (see "HALT and Resume").
4. Restart the runtime. The `ensureDailyBudget()` function in `src/index.js` creates a new daily budget row on startup using the `DAILY_BUDGET_USD` env var.

### Gmail Auth Expired

**Symptom**: `[orchestrator] Gmail poll error: invalid_grant` or `gmail_connected: false` in `/api/status`.

**Diagnostic**: Check `.env` for `GMAIL_REFRESH_TOKEN`. If present but rejected by Google, the token has expired or been revoked.

**Fix**:

1. Re-run the OAuth setup:
   ```bash
   npm run setup-gmail
   ```
2. Or use the dashboard's browser-based OAuth flow (navigate to the dashboard, it prompts for Gmail connection).
3. The OAuth callback handler (`GET /api/auth/gmail-callback` in `src/api.js`) writes the new token to both `.env` and `process.env`, so no restart is needed if using the browser flow.

### Postgres Connection Failed

**Symptom**: API returns 500 errors. Logs show `[db] Pool error:` messages or `connect ECONNREFUSED`.

**Diagnostic**:

```bash
# Check if the Docker container is running
docker ps | grep autobot-postgres

# Check container logs
docker logs autobot-postgres --tail 20

# Test connectivity
docker exec autobot-postgres pg_isready -U autobot
```

**Fix**:

1. If container is stopped: `docker start autobot-postgres`
2. If container does not exist: recreate it (see deployment runbook).
3. Verify `DATABASE_URL` in `.env` matches the container's credentials and port.
4. Check the connection pool settings in `src/db.js`: `max: 5`, `connectionTimeoutMillis: 5000`, `idleTimeoutMillis: 30000`. If the pool is exhausted, leaked connections from crashed transactions may be the cause. Restart the runtime to reset the pool.

### Hash Chain Broken

**Symptom**: Audit or verification tools report hash chain integrity failure.

**Explanation**: The `state_transitions` table is append-only with SHA-256 hash chaining. Each transition's hash is computed as `sha256(prevHash|transitionId|workItemId|fromState|toState|agentId|configHash)`. If a row was corrupted or inserted out of order, the chain breaks.

**Diagnostic**:

```sql
-- Verify the hash chain for a specific work item
-- Each row's hash_chain_current should equal sha256 of the previous row's hash + current row's fields
SELECT id, work_item_id, from_state, to_state, agent_id,
       encode(hash_chain_current, 'hex') AS current_hash,
       created_at
FROM agent_graph.state_transitions
WHERE work_item_id = '<work_item_id>'
ORDER BY created_at;
```

**Fix**:

1. Identify which transition has the wrong hash by walking the chain manually.
2. Hash chain breaks do not stop the system -- they are an audit integrity signal.
3. Investigate the cause: was a row manually inserted? Was there a PGlite/Postgres mode switch mid-operation?
4. Document the break and its cause. The append-only table cannot be corrected without violating immutability (D4).

### Agent Crash Loop

**Symptom**: An agent's log shows repeated `Fatal error` messages. The reaper logs `Found X stuck task(s)` repeatedly for the same work items.

**Diagnostic**:

```sql
-- Find tasks stuck in in_progress for longer than 5 minutes
SELECT id, title, assigned_to, status, retry_count, updated_at,
       EXTRACT(EPOCH FROM (now() - updated_at)) / 60 AS minutes_stuck
FROM agent_graph.work_items
WHERE status = 'in_progress'
  AND updated_at < now() - interval '5 minutes'
ORDER BY updated_at;

-- Check if any tasks have exceeded max retries (3)
SELECT id, title, assigned_to, retry_count, status
FROM agent_graph.work_items
WHERE retry_count >= 3
ORDER BY updated_at DESC
LIMIT 10;
```

**Fix**:

1. The reaper (`src/runtime/reaper.js`) automatically handles stuck tasks:
   - Tasks stuck > 5 minutes are transitioned to `timed_out`.
   - The orchestrator retries up to 3 times.
   - After 3 retries, the task transitions to `failed`.
2. If the agent itself is crashing (not just timing out), check the error message in logs. Common causes:
   - Anthropic API errors (rate limit, invalid key, model unavailable)
   - Malformed email data causing parsing failures
   - Missing voice profile data for the responder
3. To manually unstick a specific task:
   ```sql
   UPDATE agent_graph.work_items
   SET status = 'failed', updated_at = now()
   WHERE id = '<work_item_id>';
   ```

### Dead-Man Switch Triggered

**Symptom**: System halts with log message referencing "dead-man switch". HALT signal has `triggered_by = 'dead_man_switch'`.

**Explanation**: The dead-man switch requires board renewal every 30 days (spec section 8). If missed > 3 consecutive daily checks, the system enters standby (HALT). If missed > 30 days, it triggers graceful shutdown.

**Diagnostic**:

```sql
SELECT id, status, last_renewal, consecutive_missed,
       EXTRACT(DAY FROM (now() - last_renewal)) AS days_since_renewal
FROM agent_graph.dead_man_switch
WHERE id = 'primary';
```

**Fix**:

1. Renew the switch via CLI or API. The `renewDeadManSwitch(renewedBy)` function in `src/runtime/dead-man-switch.js` resets the timer, clears the missed counter, sets status to `active`, and resolves the halt signal.
2. If the switch is in `shutdown` state (> 30 days), renewal still works -- it clears the halt and returns the system to `active`.

## HALT and Resume

### Triggering HALT

HALT stops all agent processing immediately. Three ways to trigger:

1. **Dashboard API**:
   ```bash
   curl -X POST http://localhost:3001/api/halt
   ```

2. **CLI**: Use `npm run cli` and select the halt option.

3. **Automatic**: Budget exhaustion (G1) or dead-man switch timeout inserts a halt signal into `agent_graph.halt_signals`.

When HALT is active:
- `isHalted()` returns `true` (checked by every agent on every loop iteration, cached for 2 seconds).
- `guardCheck()` fails with `halt_active` for all new task claims.
- Existing in-progress tasks complete their current operation but no new tasks are claimed.

### Resuming

1. **Dashboard API**:
   ```bash
   curl -X POST http://localhost:3001/api/resume
   ```

2. This calls `clearHalt()` in `src/runtime/event-bus.js`, which:
   - Marks all unprocessed `halt_signal` events in `task_events` as processed.
   - Sets `is_active = false` on all active rows in `halt_signals`.

3. Agents resume within 2 seconds (halt cache TTL).

### Verifying HALT Status

```sql
-- Check halt_signals table
SELECT id, signal_type, reason, triggered_by, is_active, created_at
FROM agent_graph.halt_signals
WHERE is_active = true;

-- Check task_events for legacy halt signals
SELECT event_id, event_type, event_data, created_at
FROM agent_graph.task_events
WHERE event_type = 'halt_signal' AND processed_at IS NULL;
```

## Diagnostic Queries

### Pipeline Health

```sql
-- Unprocessed events (backlog)
SELECT target_agent_id, COUNT(*) AS pending
FROM agent_graph.task_events
WHERE processed_at IS NULL
GROUP BY target_agent_id
ORDER BY pending DESC;

-- Work items by status
SELECT status, COUNT(*) AS count
FROM agent_graph.work_items
GROUP BY status
ORDER BY count DESC;

-- Recent state transitions (last 20)
SELECT id, work_item_id, from_state, to_state, agent_id, reason,
       created_at
FROM agent_graph.state_transitions
ORDER BY created_at DESC
LIMIT 20;
```

### Budget Status

```sql
-- Today's budget
SELECT scope, allocated_usd, spent_usd, reserved_usd,
       (allocated_usd - spent_usd - reserved_usd) AS remaining_usd,
       ROUND((spent_usd / NULLIF(allocated_usd, 0)) * 100, 2) AS utilization_pct
FROM agent_graph.budgets
WHERE scope = 'daily' AND period_start = CURRENT_DATE;

-- Cost breakdown by agent today
SELECT agent_id, COUNT(*) AS calls,
       ROUND(SUM(cost_usd)::numeric, 4) AS total_cost_usd,
       SUM(input_tokens) AS total_input_tokens,
       SUM(output_tokens) AS total_output_tokens
FROM agent_graph.llm_invocations
WHERE created_at >= CURRENT_DATE
GROUP BY agent_id
ORDER BY total_cost_usd DESC;
```

### Email Pipeline

```sql
-- Emails awaiting triage
SELECT id, from_address, subject, received_at
FROM inbox.emails
WHERE triage_category = 'pending'
ORDER BY received_at DESC
LIMIT 10;

-- Drafts awaiting board review
SELECT d.id, d.subject, d.reviewer_verdict, d.board_action, d.created_at,
       e.from_address
FROM inbox.drafts d
JOIN inbox.emails e ON e.id = d.email_id
WHERE d.reviewer_verdict IS NOT NULL AND d.board_action IS NULL
ORDER BY d.created_at ASC;

-- Triage distribution today
SELECT triage_category, COUNT(*) AS count
FROM inbox.emails
WHERE processed_at >= CURRENT_DATE
GROUP BY triage_category
ORDER BY count DESC;
```

### Stuck Tasks

```sql
-- Tasks stuck in in_progress > 5 minutes
SELECT id, title, assigned_to, retry_count, status,
       updated_at,
       EXTRACT(EPOCH FROM (now() - updated_at)) / 60 AS minutes_stuck
FROM agent_graph.work_items
WHERE status = 'in_progress'
  AND updated_at < now() - interval '5 minutes'
ORDER BY updated_at;

-- Failed tasks (exhausted retries)
SELECT id, title, assigned_to, retry_count, status, updated_at
FROM agent_graph.work_items
WHERE status = 'failed'
ORDER BY updated_at DESC
LIMIT 10;
```

### Reaper Activity

```sql
-- Recent reaper-initiated transitions
SELECT id, work_item_id, from_state, to_state, reason, created_at
FROM agent_graph.state_transitions
WHERE agent_id = 'reaper'
ORDER BY created_at DESC
LIMIT 10;
```

## Running Diagnostic Queries

For **real Postgres** (Docker):

```bash
docker exec -i autobot-postgres psql -U autobot -d autobot -c "<SQL>"
```

For **PGlite** (demo/dev), use the debug API:

```bash
curl "http://localhost:3001/api/debug?table=agent_graph.work_items&limit=20"
```

The debug endpoint supports these tables: `agent_graph.work_items`, `agent_graph.task_events`, `agent_graph.state_transitions`, `agent_graph.agent_configs`, `agent_graph.budgets`, `agent_graph.llm_invocations`, `agent_graph.halt_signals`, `inbox.emails`, `inbox.drafts`, `inbox.signals`, `signal.contacts`, `signal.topics`, `signal.briefings`, `voice.edit_deltas`.
