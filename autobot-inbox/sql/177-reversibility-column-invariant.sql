-- 177: OPT-68 — document the reversibility-gate structural invariant on
-- inbox.signals columns `direction` and `domain`.
--
-- The ADR-008 §2 reversibility gate derives has_external_recipient,
-- touches_money, and touches_legal from these two columns exclusively.
-- These comments make the invariant durable in the schema so any future
-- migration author sees the security constraint before widening or dropping
-- a CHECK, and DB introspection tools surface the policy.
--
-- No schema changes — CHECK constraints already exist in 001-baseline.sql:
--   direction TEXT CHECK (direction IN ('inbound', 'outbound', 'both'))
--   domain    TEXT CHECK (domain IN ('general', 'financial', 'legal', 'scheduling'))
--
-- Enforcement at the application layer:
--   normalizeDirection() in autobot-inbox/src/webhooks/signal-ingester.js
--   normalizeDirection() in autobot-inbox/src/webhooks/signal-ingester.js
--   Unknown/LLM-inferred values → NULL (fail-safe to external for direction,
--   fail-safe to non-sensitive for domain) before any INSERT.

COMMENT ON COLUMN inbox.signals.direction IS
  'OPT-68 INVARIANT: set ONLY from structured envelope metadata (e.g. Gmail '
  'SMTP header analysis, Linear webhook direction field) via normalizeDirection() '
  'in signal-ingester.js. Unknown or LLM-inferred values are coerced to NULL '
  '(not ''inbound'') so the ADR-008 reversibility gate treats them as external '
  '(fail-safe). Direct UPDATE to this column after INSERT is disallowed by '
  'policy — the classification must not be alterable by message content.';

COMMENT ON COLUMN inbox.signals.domain IS
  'OPT-68 INVARIANT: set ONLY from structured envelope metadata via '
  'normalizeDomain() in signal-ingester.js. CHECK constraint enforces the '
  'allowlist (''general'',''financial'',''legal'',''scheduling''). Unknown or '
  'LLM-inferred values are coerced to NULL (not ''financial''/''legal'') so the '
  'ADR-008 reversibility gate cannot be tricked by prompt injection into treating '
  'a general obligation as financial/legal. Related: ADR-008, ADR-013, OPT-68.';
