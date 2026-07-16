-- 069: Wire signed contracts to the agent task graph.
--
-- Background
-- ----------
-- When all signers complete, signature_requests.status flips to 'completed'
-- via append_signature_event(), and… nothing happens. The signed document
-- is the authority token for work UMB just agreed to do, but today it dead-
-- ends in a PDF archive. This is the Optimus-native gap — a signed contract
-- should spawn agent_graph.work_items that authorize the deliverables.
--
-- Change
-- ------
-- * signatures.signature_requests gains work_items_spawned_at TIMESTAMPTZ.
--   Serves as an idempotency anchor: if two signers finish concurrently and
--   both observe status='completed', a conditional UPDATE ensures only one
--   wins the race and proceeds with commitment extraction.
-- * agent_graph.work_items.metadata grows two conventional keys:
--     contract_draft_id       — UUID from content.drafts
--     signature_request_id    — UUID from signatures.signature_requests
--   Not a column change; just a conventional documented shape. The
--   idx_work_items_contract partial index lets the contract detail page
--   query "work items spawned from this contract" cheaply.
--
-- Non-goals
-- ---------
-- * No agent auto-assignment — spawned items stay unassigned so the
--   orchestrator or a board member can triage. Direct assignment is
--   governance-sensitive and should be a deliberate step.

ALTER TABLE signatures.signature_requests
  ADD COLUMN IF NOT EXISTS work_items_spawned_at TIMESTAMPTZ;

COMMENT ON COLUMN signatures.signature_requests.work_items_spawned_at IS
  'Non-null once lib/contracts/spawn-work-items.js has successfully created '
  'work_items for this request. The claim-then-spawn pattern uses a '
  'conditional UPDATE to make spawning idempotent under concurrent signer '
  'completion.';

-- Partial index for the "work items for this contract" query — most
-- work_items rows have neither key, so a full index would be wasteful.
-- Cross-schema FKs are prohibited (D5); this is just a lookup index on the
-- metadata path, not a referential constraint.
CREATE INDEX IF NOT EXISTS idx_work_items_contract
  ON agent_graph.work_items ((metadata->>'contract_draft_id'))
  WHERE metadata ? 'contract_draft_id';
