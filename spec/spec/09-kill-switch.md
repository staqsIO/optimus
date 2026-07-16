## 9. Kill Switch

> **Note:** §8 Graduated Escalation provides scoped threat response (Level 1-4) for localized threats. This section covers system-wide HALT. The two are complementary — graduated escalation handles one agent or workstream; HALT stops everything.

### Three-Tier Design

| Tier | Trigger | Check Frequency | Response Time |
|------|---------|----------------|---------------|
| Financial circuit breaker | Expense exceeds Article 3.4 limits | Every expense | Immediate — writes to `halt_signals` table |
| Auditor-triggered halt | Constitutional violation detected | Tier 1: every cycle (~30-60s) / Tier 2: daily | Sub-minute (agents check `halt_signals` every cycle) |
| Human kill switch | Creator/board URL check | Every 60 seconds | Fail-closed after 3 consecutive failed checks (~3 min); standby > 24 hours; shutdown > 30 days (dead-man's switch) |

### HALT Protocol

When any halt signal is active:

1. All agents stop processing new events
2. All agents complete their current task (no mid-task abort — prevents corrupted state)
3. All unsent messages in the Communication Gateway's cool-down buffer transition to `cancelled` (a buffered message is not a "current task")
4. Each agent writes a status record to the task graph with current state
5. **Identity revocation:** Orchestration layer revokes all agent JWT tokens and disables agent database roles. This is a hard kill — agents cannot even authenticate to start new work. Identity is the control plane for agent security; the ability to revoke an agent's identity instantly is more important than any software signal. JWT revocation is immediate (short-lived tokens + revocation list check). Database role disablement is a `ALTER ROLE ... NOLOGIN` executed by the orchestration layer's privileged role. This step executes AFTER agents have written their status (step 4) but BEFORE standby, ensuring clean shutdown with no orphaned state.
6. Agents enter standby — checking only for RESUME from board/creator (via a dedicated standby-only credential that permits `SELECT` on `halt_signals` only)
7. On RESUME: board re-enables database roles and issues fresh JWT tokens. Agents re-authenticate before processing any events.
8. Board receives immediate notification via all configured digest channels

### Dead-Man's Switch (AutoBot only)

If the creator/board has not confirmed a "RUN" response for 30 consecutive days, the system executes Graceful Shutdown. This ensures that if the creator disappears, the system does not run indefinitely without oversight.
