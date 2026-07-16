## 12. Database Architecture (AutoBot Extension)

Optimus uses only the `agent_graph` schema. AutoBot adds four additional isolated schemas:

```
+-------------------+  reads   +-------------------+
| agent_graph       | <------- | autobot_finance   |
| (Optimus core)    |          | (Financial Script) |
|                   |          |                    |
| Agents: R/W       |          | Agents: SELECT only|
| Finance: SELECT   |          | Finance Script: R/W|
+-------------------+          +-------------------+
                                        |
                                        | sends allocation
                                        v
                               +-------------------+
                               | autobot_distrib   |
                               | (Distribution     |
                               |  Mechanism)       |
                               |                   |
                               | Agents: SELECT    |
                               | Distrib Script:R/W|
                               +-------------------+

+-------------------+          +-------------------+
| autobot_public    |          | autobot_comms     |
| (Transparency)    |          | (Communication    |
|                   |          |  Gateway)         |
| Orchestration: W  |          |                   |
| Agents: SELECT    |          | Agents: intent API|
| External: SELECT  |          | Gateway: R/W      |
| (via read replica)|          | Audit: SELECT     |
+-------------------+          +-------------------+
```

**No foreign keys cross schema boundaries.** Schemas are isolated by database roles. Each immutable component (Financial Script, Distribution Mechanism, Communication Gateway) has its own credentials that no agent process possesses.

**Cross-schema consistency model:** Since cross-schema FKs are not used, all cross-schema references point to stable, immutable identifiers (agent IDs as text, not surrogate BIGINT keys). A reconciliation job runs every 5 minutes, querying each schema for distinct cross-schema references and validating against the canonical roster. Orphaned references are flagged in `autobot_public.event_log`. This is Option B: immutable reference targets + reconciliation — it works because agent IDs are append-only in practice (deactivated, never deleted) and financial records are append-only by design.

**Key design constraints:**
- All append-only tables have triggers preventing UPDATE/DELETE
- `REVOKE TRUNCATE, DROP, ALTER` on every append-only table from all application roles (TRUNCATE bypasses row-level triggers; DROP/ALTER could destroy audit history)
- `REVOKE TRIGGER` on append-only tables from all application roles (prevents disabling UPDATE/DELETE triggers)
- Event trigger-based DDL audit logging on append-only tables (`ddl_command_end` trigger logs to `autobot_audit.ddl_log` and blocks unauthorized DDL on protected schemas). Strictly more powerful than pgaudit for this use case: can both log AND prevent unauthorized DDL in the same transaction. Works on all Postgres hosting providers including Supabase Pro.
- Hash chains on append-only tables enable tamper detection (`verify_ledger_chain()`)
  - Algorithm: SHA-256
  - Checkpoint: every 10,000 rows or every hour
  - Cross-partition: first row of each partition chains from last row of previous
  - Verification returns the specific row of divergence, not just pass/fail
- Financial accounts table: UNIQUE + CHECK constraints make a third account structurally impossible
- Monthly allocation table: CHECK constraints enforce the 40/20/40 split (reinvestment / data_contribution_fees / random_distribution) with rounding tolerance: `ABS(reinvestment + data_contribution_fees + random_distribution - net_profit) < 0.01`
- All monetary columns: `NUMERIC(15,6)` for internal tracking (sub-cent precision required — $0.014 per invocation cannot be stored in `NUMERIC(10,2)`). Rounding rule: banker's rounding (ROUND_HALF_EVEN) via custom PL/pgSQL `bankers_round()` function (Postgres does not natively support ROUND_HALF_EVEN).
- `v_budget_status` is a regular view (always current), NOT a materialized view — a materialized snapshot allows two agents to pass the same stale budget check simultaneously
- All database queries MUST use parameterized queries (prepared statements). No string interpolation of values into SQL. This is enforced at the adapter layer — the contract interface accepts structured parameters, not raw SQL strings.
- Connection pooling: each agent process uses a connection pool (e.g., `pg` pool with `max: 5`). Each immutable component (Financial Script, Distribution Mechanism, etc.) uses a separate pool with its own credentials. Total connections budgeted for Supabase Pro limits (60 direct connections + Supavisor pooler for overflow).
