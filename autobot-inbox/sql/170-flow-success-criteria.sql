-- migration 170 — add success_criteria to flow_definitions (OPT-3)
--
-- flow_definitions carry declarative pipeline specs. Adding success_criteria
-- here lets the flow-engine's gateFlowCompletion() check the flow's own output
-- against upfront criteria before writing status='completed'.
--
-- Format mirrors agent_graph.campaigns.success_criteria, DECLARATIVE form only:
--   [{ "field": "quality_score", "operator": ">=", "value": 0.85, "text": "..." }]
-- NOTE: criteria sourced from this column MUST be declarative {field,operator,value}.
-- The verifier's function-based criteria ({ check: (obs) => ... }) cannot be
-- represented in JSONB and are reserved for in-code (dev-side) callers — a
-- serialized "check" string is NOT evaluated; it fails closed (P1).
--
-- NULL / empty array = no gate (backward-compatible: all existing flows pass through).

ALTER TABLE agent_graph.flow_definitions
  ADD COLUMN IF NOT EXISTS success_criteria JSONB NOT NULL DEFAULT '[]';

COMMENT ON COLUMN agent_graph.flow_definitions.success_criteria IS
  'Optional array of success-criteria gate objects evaluated by lib/runtime/verifier.js
   before the flow_execution transitions to completed. Empty array = no gate (pass-through).
   Format: [{"field": "<dot.path>", "operator": ">=", "value": 0.85, "text": "<label>"}]
   See OPT-3 and lib/runtime/verifier.js for the full criterion shape spec.';
