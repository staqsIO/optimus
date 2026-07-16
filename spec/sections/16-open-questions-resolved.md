---
title: "Open Questions Resolved"
section: 16
tier: planning
description: "Previously open questions now resolved with decisions"
---
## 16. Open Questions Resolved

v0.1 posed six open questions. v0.4 resolves them:

| v0.1 Question | v0.4 Resolution |
|--------------|-----------------|
| Self-hosted vs cloud email? | Moot. Email replaced by Postgres task graph (self-hosted). External communication via Gateway using cloud services (SES, Twilio) for delivery only — agents never touch those credentials. |
| Agent replacement policy? | Board decides. New agent runs in shadow mode with measurement-based exit criteria (up to 7 days). Full replacement history logged. See §11. |
| Inter-department communication? | All communication routes through the task graph. Cross-department tasks are visible to both department orchestrators. No direct peer-to-peer messaging — all paths auditable by structure. |
| Real-time vs batch? | Event-driven via `pg_notify` as a wake-up signal + outbox polling as fallback. `pg_notify` notifications are lost if no listener is connected — the outbox (`task_events` + `FOR UPDATE SKIP LOCKED`) is the durable source of truth. If `pg_notify` is missed, agents poll the outbox on a 5-30 second fallback interval. Note: `pg_notify` payload limit is 8,000 bytes — notifications carry only the event ID, not the full payload. |
| External communication? | Via Communication Gateway with risk-tiered release. See §7. |
| Intellectual property? | Work product owned by the legal entity (LLC). Protected by database access controls, not email encryption. All agent outputs stored in the task graph under the entity's infrastructure. |

---
