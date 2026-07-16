-- Migration 091: chain_seq for agent_graph.state_transitions
--
-- Phase 1 metric M8 (m8_hash_chain_valid) was returning false because the
-- ledger verifier orders rows by (created_at, id) and sub-second retry
-- transitions can land with created_at values that don't reflect actual write
-- order. The hash chain itself is internally consistent — only the *ordering*
-- the verifier walks is wrong, producing false-positive break reports.
--
-- The writer has a parallel bug: agent_graph.transition_state() reads
-- "latest" prev_hash by `ORDER BY created_at DESC LIMIT 1`, which under
-- retry storms can pick a row that's not the most recent in chain order.
-- That can produce a real fork (two rows with the same prev_hash).
--
-- Fix: add a strictly-monotonic chain_seq column populated via a sequence.
-- Verifier orders by chain_seq. Writer reads prev_hash by chain_seq DESC.
-- The column is an ordering hint, not a cryptographic commitment — the
-- hash chain itself remains the integrity primitive.
--
-- Linus reviewed the original sketch (recursive CTE backfill, UNIQUE
-- constraint) and surfaced three blockers we fix here:
--   1) UNIQUE (work_item_id, chain_seq) cannot span partitions —
--      state_transitions is range-partitioned by created_at monthly.
--      We rely on writer serialization (FOR UPDATE on work_items) and
--      sequence monotonicity instead.
--   2) Recursive CTE backfill leaves NULL chain_seq on chains with hash
--      gaps (genuine corruption, not the timestamp false-positive). We
--      backfill clean chains via the CTE, then fill dirty chains with a
--      fallback (work_item_id, created_at, id) ordering so SET NOT NULL
--      cannot blow up mid-migration.
--   3) Multi-NULL-prev rows on the same work_item produce duplicate seq=1
--      from the CTE. Pre-flight detects them and the fallback covers them.

-- ---------- 1. Pre-flight diagnostics (informational) ----------
DO $$
DECLARE
  v_total_chains BIGINT;
  v_invalid_chains BIGINT;
  v_multi_null BIGINT;
  v_total_rows BIGINT;
BEGIN
  SELECT COUNT(*) INTO v_total_rows FROM agent_graph.state_transitions;
  SELECT COUNT(DISTINCT work_item_id) INTO v_total_chains FROM agent_graph.state_transitions;

  SELECT COUNT(*) INTO v_invalid_chains
  FROM agent_graph.verify_all_ledger_chains() WHERE NOT is_valid;

  SELECT COUNT(*) INTO v_multi_null
  FROM (
    SELECT work_item_id
    FROM agent_graph.state_transitions
    WHERE hash_chain_prev IS NULL
    GROUP BY work_item_id
    HAVING COUNT(*) > 1
  ) t;

  RAISE NOTICE '[091] state_transitions rows=% chains=%', v_total_rows, v_total_chains;
  RAISE NOTICE '[091] chains reported invalid by old verifier: %', v_invalid_chains;
  RAISE NOTICE '[091] multi-NULL-prev anchors (will use fallback ordering): %', v_multi_null;
END $$;

-- ---------- 2. Add chain_seq column + sequence ----------
CREATE SEQUENCE IF NOT EXISTS agent_graph.state_transitions_chain_seq;

ALTER TABLE agent_graph.state_transitions
  ADD COLUMN IF NOT EXISTS chain_seq BIGINT;

-- ---------- 2a. Temporarily disable the no-update trigger for backfill ----------
-- state_transitions is append-only in production via prevent_mutation(). We
-- need a single-shot UPDATE pass to populate chain_seq on existing rows.
-- Disable trg_state_transitions_no_update on parent and every partition,
-- run the backfill, then re-enable. The whole migration runs in one
-- transaction so a crash mid-migration leaves the trigger restored.
DO $$
DECLARE
  v_tbl TEXT;
BEGIN
  -- Parent
  EXECUTE 'ALTER TABLE agent_graph.state_transitions DISABLE TRIGGER trg_state_transitions_no_update';
  -- Each partition
  FOR v_tbl IN
    SELECT inhrelid::regclass::text
    FROM pg_inherits
    WHERE inhparent = 'agent_graph.state_transitions'::regclass
  LOOP
    EXECUTE format('ALTER TABLE %s DISABLE TRIGGER trg_state_transitions_no_update', v_tbl);
  END LOOP;
END $$;

-- ---------- 3. Backfill clean chains in hash order ----------
-- Walk each chain from its NULL-prev anchor forward by hash chain.
-- The backfill assigns chain_seq using deterministic ordering over the
-- walked rows (ROW_NUMBER()), preserving per-chain order without nextval().
WITH RECURSIVE walked AS (
  -- Anchor: chains with exactly one NULL-prev row
  SELECT
    st.id,
    st.work_item_id,
    st.hash_chain_current,
    1::INT AS step
  FROM agent_graph.state_transitions st
  WHERE st.hash_chain_prev IS NULL
    AND st.work_item_id IN (
      SELECT work_item_id
      FROM agent_graph.state_transitions
      WHERE hash_chain_prev IS NULL
      GROUP BY work_item_id
      HAVING COUNT(*) = 1
    )
  UNION ALL
  -- Walk forward: next row in chain has prev = current row's curr.
  -- Ordered by id breaks ties deterministically if a chain has forks
  -- (a real corruption case — both forks get walked but one will skip
  -- if its prev doesn't match).
  SELECT
    next_st.id,
    next_st.work_item_id,
    next_st.hash_chain_current,
    w.step + 1
  FROM agent_graph.state_transitions next_st
  JOIN walked w
    ON next_st.work_item_id = w.work_item_id
   AND next_st.hash_chain_prev = w.hash_chain_current
),
ordered AS (
  -- Convert per-chain step -> globally monotonic sequence.
  -- Order by (work_item_id, step) so within each chain the seq is monotonic.
  SELECT id, ROW_NUMBER() OVER (ORDER BY work_item_id, step, id) AS rn
  FROM walked
)
UPDATE agent_graph.state_transitions st
SET chain_seq = ordered.rn
FROM ordered
WHERE st.id = ordered.id;

-- ---------- 4. Backfill dirty chains (fallback ordering) ----------
-- Anything not covered above (multi-NULL anchors, hash gaps, isolated rows)
-- gets chain_seq via (work_item_id, created_at, id) ordering. This is the
-- best we can do without a deeper repair pass. These rows would still be
-- reported as invalid by the verifier — that's the correct signal.
DO $$
DECLARE
  v_max BIGINT;
  v_dirty BIGINT;
BEGIN
  SELECT COALESCE(MAX(chain_seq), 0) INTO v_max FROM agent_graph.state_transitions;
  SELECT COUNT(*) INTO v_dirty FROM agent_graph.state_transitions WHERE chain_seq IS NULL;
  RAISE NOTICE '[091] backfilled clean chains up to chain_seq=%, dirty rows remaining=%', v_max, v_dirty;
END $$;

WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (ORDER BY work_item_id, created_at, id) AS rn
  FROM agent_graph.state_transitions
  WHERE chain_seq IS NULL
)
UPDATE agent_graph.state_transitions st
SET chain_seq = (SELECT COALESCE(MAX(chain_seq), 0) FROM agent_graph.state_transitions) + ranked.rn
FROM ranked
WHERE st.id = ranked.id;

-- ---------- 4a. Re-enable the no-update trigger across all partitions ----------
DO $$
DECLARE
  v_tbl TEXT;
BEGIN
  EXECUTE 'ALTER TABLE agent_graph.state_transitions ENABLE TRIGGER trg_state_transitions_no_update';
  FOR v_tbl IN
    SELECT inhrelid::regclass::text
    FROM pg_inherits
    WHERE inhparent = 'agent_graph.state_transitions'::regclass
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE TRIGGER trg_state_transitions_no_update', v_tbl);
  END LOOP;
END $$;

-- ---------- 5. Lock in the column + sequence as the source of truth ----------
SELECT setval(
  'agent_graph.state_transitions_chain_seq',
  GREATEST((SELECT COALESCE(MAX(chain_seq), 0) FROM agent_graph.state_transitions), 1)
);

ALTER TABLE agent_graph.state_transitions
  ALTER COLUMN chain_seq SET DEFAULT nextval('agent_graph.state_transitions_chain_seq'),
  ALTER COLUMN chain_seq SET NOT NULL;

-- Index so chain-ordered reads are O(log n) per work_item, not a partition scan.
CREATE INDEX IF NOT EXISTS state_transitions_work_item_chain_seq_idx
  ON agent_graph.state_transitions (work_item_id, chain_seq);

-- ---------- 6. Update verify_ledger_chain to use chain_seq ----------
CREATE OR REPLACE FUNCTION agent_graph.verify_ledger_chain(
  p_work_item_id text DEFAULT NULL
) RETURNS TABLE(
  is_valid BOOLEAN,
  broken_at_id TEXT,
  broken_at_time TIMESTAMPTZ,
  expected_prev_hash TEXT,
  actual_prev_hash TEXT,
  rows_checked BIGINT
) AS $func$
DECLARE
  v_row RECORD;
  v_prev_hash BYTEA := NULL;
  v_count BIGINT := 0;
  v_wi_id TEXT;
BEGIN
  IF p_work_item_id IS NOT NULL THEN
    FOR v_row IN
      SELECT st.id, st.hash_chain_prev, st.hash_chain_current, st.created_at, st.chain_seq
      FROM agent_graph.state_transitions st
      WHERE st.work_item_id = p_work_item_id
      ORDER BY st.chain_seq
    LOOP
      v_count := v_count + 1;
      IF v_prev_hash IS NOT NULL THEN
        IF v_row.hash_chain_prev IS DISTINCT FROM v_prev_hash THEN
          is_valid := FALSE;
          broken_at_id := v_row.id;
          broken_at_time := v_row.created_at;
          expected_prev_hash := encode(v_prev_hash, 'hex');
          actual_prev_hash := COALESCE(encode(v_row.hash_chain_prev, 'hex'), 'NULL');
          rows_checked := v_count;
          RETURN NEXT;
          RETURN;
        END IF;
      END IF;
      v_prev_hash := v_row.hash_chain_current;
    END LOOP;

    is_valid := TRUE;
    broken_at_id := NULL;
    broken_at_time := NULL;
    expected_prev_hash := NULL;
    actual_prev_hash := NULL;
    rows_checked := v_count;
    RETURN NEXT;
  ELSE
    FOR v_wi_id IN
      SELECT DISTINCT st2.work_item_id FROM agent_graph.state_transitions st2
    LOOP
      v_prev_hash := NULL;
      v_count := 0;

      FOR v_row IN
        SELECT st.id, st.hash_chain_prev, st.hash_chain_current, st.created_at, st.chain_seq
        FROM agent_graph.state_transitions st
        WHERE st.work_item_id = v_wi_id
        ORDER BY st.chain_seq
      LOOP
        v_count := v_count + 1;
        IF v_prev_hash IS NOT NULL THEN
          IF v_row.hash_chain_prev IS DISTINCT FROM v_prev_hash THEN
            is_valid := FALSE;
            broken_at_id := v_row.id;
            broken_at_time := v_row.created_at;
            expected_prev_hash := encode(v_prev_hash, 'hex');
            actual_prev_hash := COALESCE(encode(v_row.hash_chain_prev, 'hex'), 'NULL');
            rows_checked := v_count;
            RETURN NEXT;
            EXIT;
          END IF;
        END IF;
        v_prev_hash := v_row.hash_chain_current;
      END LOOP;

      IF v_count > 0 AND (broken_at_id IS NULL OR broken_at_id NOT IN (
        SELECT b.broken_at_id FROM (VALUES (broken_at_id)) AS b(broken_at_id)
      )) THEN
        -- Chain walked clean: emit a valid result for this work_item
        IF NOT FOUND OR (v_prev_hash IS NOT NULL) THEN
          is_valid := TRUE;
          broken_at_id := NULL;
          broken_at_time := NULL;
          expected_prev_hash := NULL;
          actual_prev_hash := NULL;
          rows_checked := v_count;
          RETURN NEXT;
        END IF;
      END IF;
    END LOOP;
  END IF;
END;
$func$ LANGUAGE plpgsql;

-- ---------- 7. Update transition_state to read prev_hash by chain_seq ----------
-- Recreate with the same signature; only the prev_hash read is changed.
-- Everything else (FOR UPDATE NOWAIT on work_items, dual-path hash, INSERT)
-- is preserved verbatim.
CREATE OR REPLACE FUNCTION agent_graph.transition_state(
  p_work_item_id TEXT,
  p_to_state TEXT,
  p_agent_id TEXT,
  p_config_hash TEXT,
  p_reason TEXT DEFAULT NULL,
  p_guardrail_checks JSONB DEFAULT '{}'::jsonb,
  p_cost_usd NUMERIC DEFAULT 0,
  p_transition_id TEXT DEFAULT NULL,
  p_hash_chain_current TEXT DEFAULT NULL
) RETURNS TABLE(
  success BOOLEAN,
  transition_id TEXT,
  from_state TEXT,
  prev_hash TEXT
) AS $func$
DECLARE
  v_current_state TEXT;
  v_transition_valid BOOLEAN;
  v_required_guardrails TEXT[];
  v_prev_hash TEXT;
  v_tid TEXT;
  v_hash TEXT;
  v_payload TEXT;
BEGIN
  -- Serialize concurrent transitions on the same work_item.
  SELECT status INTO v_current_state
  FROM agent_graph.work_items
  WHERE id = p_work_item_id
  FOR UPDATE NOWAIT;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Work item % not found', p_work_item_id;
  END IF;

  SELECT true, required_guardrails
  INTO v_transition_valid, v_required_guardrails
  FROM agent_graph.valid_transitions
  WHERE agent_graph.valid_transitions.from_state = v_current_state
    AND agent_graph.valid_transitions.to_state = p_to_state
    AND (p_agent_id = ANY(allowed_roles) OR '*' = ANY(allowed_roles));

  IF v_transition_valid IS NOT TRUE THEN
    success := FALSE;
    RETURN NEXT;
    RETURN;
  END IF;

  -- Read prev_hash by chain_seq (monotonic), not created_at (which can lie
  -- under sub-second concurrency). See migration 091 for context.
  SELECT encode(hash_chain_current, 'hex') INTO v_prev_hash
  FROM agent_graph.state_transitions
  WHERE work_item_id = p_work_item_id
  ORDER BY chain_seq DESC
  LIMIT 1;

  v_tid := COALESCE(p_transition_id, gen_random_uuid()::text);

  IF p_hash_chain_current IS NOT NULL THEN
    v_hash := p_hash_chain_current;
  ELSE
    v_payload := COALESCE(v_prev_hash, 'genesis') || '|' ||
                 v_tid || '|' || p_work_item_id || '|' ||
                 v_current_state || '|' || p_to_state || '|' ||
                 p_agent_id || '|' || p_config_hash;
    v_hash := encode(sha256(v_payload::bytea), 'hex');
  END IF;

  UPDATE agent_graph.work_items
  SET status = p_to_state,
      updated_at = now()
  WHERE id = p_work_item_id;

  -- chain_seq fills via DEFAULT nextval(...) — no explicit value here.
  INSERT INTO agent_graph.state_transitions (
    id, work_item_id, from_state, to_state,
    agent_id, config_hash, reason, guardrail_checks_json,
    cost_usd, hash_chain_prev, hash_chain_current
  ) VALUES (
    v_tid, p_work_item_id, v_current_state, p_to_state,
    p_agent_id, p_config_hash, p_reason, p_guardrail_checks,
    p_cost_usd,
    CASE WHEN v_prev_hash IS NOT NULL THEN decode(v_prev_hash, 'hex') ELSE NULL END,
    decode(v_hash, 'hex')
  );

  IF p_to_state IN ('completed', 'failed') THEN
    INSERT INTO agent_graph.task_events
      (event_type, work_item_id, target_agent_id, priority, event_data)
    VALUES (
      'state_changed', p_work_item_id,
      'orchestrator',
      0,
      jsonb_build_object(
        'from_state', v_current_state,
        'to_state', p_to_state,
        'agent_id', p_agent_id,
        'transition_id', v_tid,
        'work_item_id', p_work_item_id
      )
    );
  END IF;

  success := TRUE;
  transition_id := v_tid;
  from_state := v_current_state;
  prev_hash := COALESCE(v_prev_hash, '');
  RETURN NEXT;
END;
$func$ LANGUAGE plpgsql;

-- ---------- 8. Post-migration verification (informational) ----------
DO $$
DECLARE
  v_invalid_after BIGINT;
BEGIN
  SELECT COUNT(*) INTO v_invalid_after
  FROM agent_graph.verify_all_ledger_chains() WHERE NOT is_valid;
  RAISE NOTICE '[091] chains invalid AFTER chain_seq fix: % (was reported by old verifier as 3)', v_invalid_after;
  IF v_invalid_after > 0 THEN
    RAISE NOTICE '[091] residual invalid chains likely indicate genuine hash gaps (covered by fallback backfill); investigate via verify_ledger_chain($1) for specific work_item_ids.';
  END IF;
END $$;
