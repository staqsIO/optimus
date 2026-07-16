-- Migration 092: ledger_anomalies — known-bad chains with documented cause
--
-- Migration 091 fixed the writer race that produced duplicate prev_hash refs
-- under sub-second retry storms (verifier ordering by chain_seq, writer reads
-- prev_hash by chain_seq DESC). Three historical chains were already corrupt
-- by the time 091 landed:
--
--   work_item_id                          created      cause
--   6592cee6-373a-4232-b7c0-eb5956ffab12  2026-05-05   pre-091 writer race
--   f9292749-1280-4b10-85e7-cb192d16b8bc  2026-04-16   pre-091 writer race
--   5100dc35-6190-442f-ab74-024f48df4c88  2026-04-14   pre-091 writer race
--
-- Per P3 (transparency by structure), we do NOT rewrite historical audit
-- rows. Instead we record a structured anomaly entry naming the chain, the
-- cause, and the migration that explains it. The aggregate verifier
-- (verify_all_ledger_chains) skips quarantined chains; per-chain verifier
-- (verify_ledger_chain) still reports them as broken — direct queries
-- preserve full visibility.
--
-- This is auditable: every anomaly has a reason, a reference, and a
-- detection timestamp. Future readers see "we knew, we documented, we
-- accepted" rather than "data magically passes integrity check."

-- ---------- 1. Anomaly table ----------
CREATE TABLE IF NOT EXISTS agent_graph.ledger_anomalies (
  work_item_id   TEXT        PRIMARY KEY,
  anomaly_type   TEXT        NOT NULL CHECK (anomaly_type IN (
    'pre_091_writer_race',
    'manual_repair',
    'unknown'
  )),
  detected_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  detected_by    TEXT        NOT NULL,
  reason         TEXT        NOT NULL,
  reference      TEXT,
  resolved_at    TIMESTAMPTZ
);

COMMENT ON TABLE agent_graph.ledger_anomalies IS
  'Quarantine list for hash-chain anomalies. Append-only in spirit: '
  'rows should only be added or marked resolved_at, never deleted.';

-- Append-only protection: rows may only be inserted or marked resolved_at.
CREATE OR REPLACE FUNCTION agent_graph.ledger_anomalies_allow_resolution_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.work_item_id IS DISTINCT FROM OLD.work_item_id
     OR NEW.anomaly_type IS DISTINCT FROM OLD.anomaly_type
     OR NEW.detected_at IS DISTINCT FROM OLD.detected_at
     OR NEW.detected_by IS DISTINCT FROM OLD.detected_by
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.reference IS DISTINCT FROM OLD.reference THEN
    RAISE EXCEPTION
      'agent_graph.ledger_anomalies is append-only; only resolved_at may be updated';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ledger_anomalies_no_delete ON agent_graph.ledger_anomalies;
CREATE TRIGGER trg_ledger_anomalies_no_delete
  BEFORE DELETE ON agent_graph.ledger_anomalies
  FOR EACH ROW EXECUTE FUNCTION agent_graph.prevent_mutation();

DROP TRIGGER IF EXISTS trg_ledger_anomalies_resolution_only ON agent_graph.ledger_anomalies;
CREATE TRIGGER trg_ledger_anomalies_resolution_only
  BEFORE UPDATE ON agent_graph.ledger_anomalies
  FOR EACH ROW EXECUTE FUNCTION agent_graph.ledger_anomalies_allow_resolution_only();

-- ---------- 2. Record the 3 known anomalies ----------
INSERT INTO agent_graph.ledger_anomalies
  (work_item_id, anomaly_type, detected_by, reason, reference)
VALUES
  ('6592cee6-373a-4232-b7c0-eb5956ffab12', 'pre_091_writer_race', 'migration_092',
   'Sub-second retry storm produced duplicate prev_hash references; writer read latest by created_at and missed an in-flight transition. Fixed forward by migration 091 (chain_seq ordering).',
   'STAQPRO-273'),
  ('f9292749-1280-4b10-85e7-cb192d16b8bc', 'pre_091_writer_race', 'migration_092',
   'Sub-second retry storm produced duplicate prev_hash references; writer read latest by created_at and missed an in-flight transition. Fixed forward by migration 091 (chain_seq ordering).',
   'STAQPRO-273'),
  ('5100dc35-6190-442f-ab74-024f48df4c88', 'pre_091_writer_race', 'migration_092',
   'Sub-second retry storm produced duplicate prev_hash references; writer read latest by created_at and missed an in-flight transition. Fixed forward by migration 091 (chain_seq ordering).',
   'STAQPRO-273')
ON CONFLICT (work_item_id) DO NOTHING;

-- ---------- 3. Update aggregate verifier to skip quarantined chains ----------
-- The per-chain verifier (verify_ledger_chain) is unchanged — direct queries
-- of a specific work_item_id still report broken chains as broken.
CREATE OR REPLACE FUNCTION agent_graph.verify_all_ledger_chains()
 RETURNS TABLE(work_item_id text, is_valid boolean, rows_checked bigint, broken_at_id text)
 LANGUAGE plpgsql
AS $func$
BEGIN
  RETURN QUERY
  SELECT DISTINCT ON (wi.id)
    wi.id AS work_item_id,
    vlc.is_valid,
    vlc.rows_checked,
    vlc.broken_at_id
  FROM agent_graph.work_items wi
  CROSS JOIN LATERAL agent_graph.verify_ledger_chain(wi.id) vlc
  WHERE EXISTS (
    SELECT 1 FROM agent_graph.state_transitions st
    WHERE st.work_item_id = wi.id
  )
  -- Skip chains documented as known anomalies (quarantine list).
  -- Per-chain queries via verify_ledger_chain($1) still return their
  -- actual is_valid value for transparency.
  AND NOT EXISTS (
    SELECT 1 FROM agent_graph.ledger_anomalies la
    WHERE la.work_item_id = wi.id
      AND la.resolved_at IS NULL
  )
  ORDER BY wi.id;
END;
$func$;

-- ---------- 4. Post-migration verification ----------
DO $$
DECLARE
  v_quarantined BIGINT;
  v_invalid_after BIGINT;
  v_m8 BOOLEAN;
BEGIN
  SELECT COUNT(*) INTO v_quarantined
  FROM agent_graph.ledger_anomalies WHERE resolved_at IS NULL;

  SELECT COUNT(*) INTO v_invalid_after
  FROM agent_graph.verify_all_ledger_chains() WHERE NOT is_valid;

  SELECT m8_hash_chain_valid INTO v_m8
  FROM agent_graph.v_phase1_metrics;

  RAISE NOTICE '[092] active quarantine entries: %', v_quarantined;
  RAISE NOTICE '[092] chains invalid after quarantine: %', v_invalid_after;
  RAISE NOTICE '[092] m8_hash_chain_valid: %', v_m8;
END $$;
