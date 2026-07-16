# Backup and Recovery Runbook

**Date**: 2026-03-02
**Spec Reference**: SPEC.md v0.7.0 section 14 (Phase 1 Backup/DR)

## Recovery Objectives

| Objective | Target | Rationale |
|-----------|--------|-----------|
| **RTO** (Recovery Time Objective) | 30 minutes | Time from incident detection to operational system. Supabase PITR restore takes 5-15 min; app restart + hash chain verification adds 10-15 min. |
| **RPO** (Recovery Point Objective) | 5 minutes | Maximum data loss. Supabase WAL archiving provides continuous backup. Worst case: transactions in-flight at failure time. |

## Backup Infrastructure

### Managed by Supabase (automatic)

- **WAL archiving**: Continuous write-ahead log shipping to object storage
- **PITR**: Point-in-time recovery to any second within the retention window
- **Daily snapshots**: Full database backups retained per Supabase Pro plan
- **Replication**: WAL-based async replication (Supabase managed)

### Managed by Application (our responsibility)

| Component | Location | Purpose |
|-----------|----------|---------|
| Hash chain (`state_transitions.hash_chain_current`) | Every state transition row | Tamper detection — each row links to the previous via SHA-256 |
| Hash checkpoints (`agent_graph.hash_checkpoints`) | Hourly via `createHashCheckpoint()` | Periodic integrity snapshots for fast verification |
| Merkle proofs (`merkle-publisher.js`) | Daily via `publishAllProofs()` | Publishable integrity proofs over append-only tables |
| Ledger chain (`autobot_finance.ledger`) | Every financial entry | Independent hash chain for financial records |

## Restore Procedure

### Step 1: Assess the Incident

- Determine scope: data corruption, accidental deletion, infrastructure failure?
- Check Supabase status page for platform-level issues
- Note the latest known-good timestamp

### Step 2: Restore from Supabase PITR

1. Go to Supabase Dashboard → Database → Backups
2. Select "Point in Time Recovery"
3. Enter the target timestamp (latest known-good moment)
4. Confirm restore — this creates a new database instance
5. Update `DATABASE_URL` in `.env` to point to the restored instance

### Step 3: Verify Hash Chain Integrity

After restore, run the hash chain verification:

```sql
SELECT * FROM agent_graph.verify_ledger_chain();
```

Expected result: all rows pass. If gaps are found:

1. Document the gap range (from_id, to_id, from_timestamp, to_timestamp)
2. Insert a gap marker into `agent_graph.hash_checkpoints`:
   ```sql
   INSERT INTO agent_graph.hash_checkpoints (chain_name, row_count, latest_hash, verified_at, metadata)
   VALUES ('state_transitions', 0, 'GAP:restore-{date}', now(),
           '{"type": "restore_gap", "reason": "PITR restore", "gap_start": "...", "gap_end": "..."}'::jsonb);
   ```
3. Publish a new Merkle root that includes the gap documentation:
   ```bash
   node -e "import('./src/runtime/merkle-publisher.js').then(m => m.publishAllProofs())"
   ```

### Step 4: Verify Financial Ledger Chain

```sql
-- Check for broken links in the financial ledger
SELECT l1.id, l1.hash_chain_current, l2.hash_chain_prev
FROM autobot_finance.ledger l1
JOIN autobot_finance.ledger l2 ON l2.id = (
  SELECT id FROM autobot_finance.ledger WHERE created_at > l1.created_at ORDER BY created_at LIMIT 1
)
WHERE l1.hash_chain_current != l2.hash_chain_prev;
```

### Step 5: Restart Application

```bash
npm start
```

On startup, the application will:
- Run `verifyToolRegistry()` — confirms tool hashes match
- Run `syncConfigHashes()` — ensures agent configs are current
- Run `checkDeadManSwitch()` — verify dead-man's switch is not expired
- Resume agent loops and polling

### Step 6: Post-Restore Verification

- [ ] Hash chain verification passes (`verify_ledger_chain()`)
- [ ] Financial ledger chain is intact
- [ ] All 6 agents start and claim tasks successfully
- [ ] Gmail polling resumes (check last_sync_at in `inbox.accounts`)
- [ ] Dashboard loads at localhost:3100 with current data
- [ ] Kill switch responds (test `POST /api/halt` then `POST /api/resume`)
- [ ] Daily budget exists for today (`agent_graph.budgets`)

## Monthly Restore Test Procedure

**Cadence**: First Monday of each month
**Duration**: ~30 minutes
**Environment**: Supabase branch database (not production)

1. Create a Supabase branch from production
2. Apply PITR restore to a timestamp 24 hours ago
3. Run `verify_ledger_chain()` on the branch — document result
4. Run the post-restore checklist above against the branch
5. Record results in a GitHub issue tagged `runbook-test`
6. Delete the branch database

## Escalation

| Scenario | Action |
|----------|--------|
| PITR restore fails | Contact Supabase support. Fallback: restore from daily snapshot (RPO increases to ~24h) |
| Hash chain has gaps post-restore | Document gaps, publish new Merkle root with gap markers. Gaps in HITL Phase 1 are non-critical — board reviews all actions anyway |
| Dead-man's switch expired during outage | Renew immediately after restore: `node -e "import('./src/runtime/dead-man-switch.js').then(m => m.renewDeadManSwitch('board'))"` |
| Financial ledger chain broken | Flag for board review. Do not process financial allocations until chain is repaired or gap is documented |
