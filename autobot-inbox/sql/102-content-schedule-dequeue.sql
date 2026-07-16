-- 102-content-schedule-dequeue.sql
-- STAQPRO-258: schedule-driven content topic dequeue
--
-- Adds the missing piece in the Phase 1.5 content engine: a cron-driven
-- function that promotes ready content.topics rows (status='queued',
-- source='schedule', scheduled_for <= today) into agent_graph.work_items
-- where the existing executor-writer pipeline picks them up.
--
-- Design rationale (Liotta + Neo synthesis on PR review):
--   The dequeue is a deterministic SQL transaction (SELECT + UPDATE +
--   INSERT). Building it as a JS AgentLoop adds a process slot, an
--   agents.json entry, audit-per-tick rows, and an AgentLoop debugging
--   surface for zero capability the database doesn't already provide.
--   pg_cron + PL/pgSQL is the "boring infrastructure" (P4) fit.
--
--   Governance concern (Neo): pg_cron emitting work_items without an
--   agent identity would break SPEC §4 (every action traced to an agent)
--   and make the dead-man switch invisible to this path. Mitigated by:
--     (a) registering 'content-scheduler' as an agent_configs identity
--     (b) all emitted work_items have created_by = 'content-scheduler'
--     (c) function checks agent_graph.halt_signals first and bails if
--         a halt is active — dead-man switch still reaches us
--
-- Directive trigger path remains via claw-campaigner (Quick Build form);
-- this migration only adds the schedule path.

-- 1. Ensure pg_cron extension is installed — but only if available.
--    Production Supabase ships pg_cron. CI (PGlite) and most local dev
--    images do not. Guarding here means: function + FK + view + agent
--    identity get created everywhere; the cron schedule (step 7) only
--    activates where pg_cron exists. Local dev can manually invoke
--    `SELECT content.dequeue_scheduled_topics();` to test.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
    RAISE NOTICE '[102] pg_cron extension ensured';
  ELSE
    RAISE NOTICE '[102] pg_cron not available in this build — skipping extension install (function will still be created; manual invocation only)';
  END IF;
END $$;

-- 2. Register 'content-scheduler' as a governance identity so work_items
--    emitted by the dequeue function trace to a real agent in the audit
--    chain. No LLM, no system prompt — pure SQL identity.
INSERT INTO agent_graph.agent_configs (id, agent_type, model, system_prompt, config_hash)
VALUES (
  'content-scheduler',
  'orchestrator',
  'none',
  'Schedule-driven dequeue from content.topics. Pure SQL via content.dequeue_scheduled_topics(), invoked by pg_cron. Audit identity only; no LLM invocation.',
  'migration-102'
)
ON CONFLICT (id) DO NOTHING;

-- 3. Assignment rule: content-scheduler → executor-writer
--    Mirrors the existing claw-campaigner → executor-writer rule (mig 050).
INSERT INTO agent_graph.agent_assignment_rules (agent_id, can_assign)
VALUES ('content-scheduler', 'executor-writer')
ON CONFLICT (agent_id, can_assign) DO NOTHING;

-- 4. Back-reference column: link work_items to the originating content.topic.
--    Nullable (most work_items aren't content). Kept as a soft reference
--    only (no cross-schema FK) so agent_graph remains domain-agnostic and
--    restores/migrations/extractions do not depend on the content schema.
--    Status sync happens via the view in step 6 below.
ALTER TABLE agent_graph.work_items
  ADD COLUMN IF NOT EXISTS content_topic_id TEXT;

CREATE INDEX IF NOT EXISTS idx_work_items_content_topic
  ON agent_graph.work_items(content_topic_id) WHERE content_topic_id IS NOT NULL;

-- 5. The dequeue function.
--    Single SQL transaction (no race between SELECT and INSERT — the lock
--    held by SELECT FOR UPDATE persists through the implicit transaction
--    boundary of the function call).
--    SECURITY DEFINER so pg_cron's invocation context (which may lack RLS
--    setup) can still write across schemas. search_path pinned to prevent
--    SECURITY DEFINER hijack via schema search-path attacks.
--    Returns: number of topics promoted (0 or 1 per tick — one per tick
--    to spread executor-writer load across cron intervals).
CREATE OR REPLACE FUNCTION content.dequeue_scheduled_topics()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, content, agent_graph
AS $$
DECLARE
  v_topic content.topics%ROWTYPE;
  v_work_item_id TEXT;
  v_content_type TEXT;
BEGIN
  -- Governance gate: respect dead-man switch and operator halts.
  IF EXISTS (SELECT 1 FROM agent_graph.halt_signals WHERE is_active = true) THEN
    RAISE NOTICE '[content.dequeue_scheduled_topics] halt active, skipping';
    RETURN 0;
  END IF;

  -- Claim one ready topic atomically. SKIP LOCKED is defensive — pg_cron
  -- runs serially per job by default, but if the schedule ever overlaps
  -- with manual invocation we still get correctness.
  SELECT * INTO v_topic FROM content.topics
   WHERE status = 'queued'
     AND source = 'schedule'
     AND (scheduled_for IS NULL OR scheduled_for <= CURRENT_DATE)
   ORDER BY scheduled_for NULLS LAST, created_at ASC
   LIMIT 1
   FOR UPDATE SKIP LOCKED;

  IF v_topic.id IS NULL THEN
    RETURN 0;
  END IF;

  -- Map platform → content_type expected by executor-writer.
  -- Explicit case rather than ternary fallthrough: if a future platform
  -- ('twitter', 'newsletter') gets added to the CHECK constraint without
  -- updating this function, we want a hard failure, not silent default.
  v_content_type := CASE v_topic.platform
                      WHEN 'linkedin' THEN 'linkedin'
                      WHEN 'blog'     THEN 'blog'
                      WHEN 'both'     THEN 'blog'  -- atomizer derives LinkedIn downstream
                      ELSE NULL
                    END;
  IF v_content_type IS NULL THEN
    RAISE EXCEPTION 'content.dequeue_scheduled_topics: unknown platform value %', v_topic.platform;
  END IF;

  UPDATE content.topics
     SET status = 'in_progress', updated_at = now()
   WHERE id = v_topic.id;

  INSERT INTO agent_graph.work_items (
    type, title, status, created_by, assigned_to, metadata, content_topic_id
  ) VALUES (
    'directive',
    'Content: ' || v_topic.topic,
    'created',
    'content-scheduler',
    'executor-writer',
    jsonb_build_object(
      'action_type',     'content_generation',
      'topic',           v_topic.topic,
      'content_type',    v_content_type,
      'topic_area',      v_topic.topic_area,
      'target_audience', v_topic.target_audience,
      'seo_keywords',    v_topic.seo_keywords,
      'author',          v_topic.author,
      'research_brief',  v_topic.research_brief,
      'campaign_id',     v_topic.campaign_id,
      'source',          'schedule'
    ),
    v_topic.id
  )
  RETURNING id INTO v_work_item_id;

  RAISE NOTICE '[content.dequeue_scheduled_topics] promoted topic % -> work_item %',
    v_topic.id, v_work_item_id;
  RETURN 1;
END;
$$;

-- 6. Status view: replaces the need for a trigger writing content.topics
--    when work_items move. Reconciler-as-view — zero write path, P3-
--    compliant, debuggable with one SELECT, no cross-schema trigger
--    surface (preserves SPEC §12 spirit).
CREATE OR REPLACE VIEW content.topic_status_v AS
SELECT
  t.id              AS topic_id,
  t.topic,
  t.platform,
  t.source,
  t.status          AS topic_status,
  t.scheduled_for,
  wi.id             AS work_item_id,
  wi.status         AS work_item_status,
  wi.created_at     AS work_item_created_at,
  wi.updated_at     AS work_item_updated_at
FROM content.topics t
LEFT JOIN LATERAL (
  SELECT id, status, created_at, updated_at
    FROM agent_graph.work_items
   WHERE content_topic_id = t.id
   ORDER BY created_at DESC
   LIMIT 1
) wi ON true;

-- 7. Schedule the dequeue. Only runs where pg_cron is installed (production
--    Supabase). Idempotent: unschedule any pre-existing job by this name
--    first so re-running this migration doesn't create duplicates.
DO $$
DECLARE
  v_existing_jobid BIGINT;
  v_has_cron       BOOLEAN;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM pg_namespace WHERE nspname = 'cron'
  ) INTO v_has_cron;

  IF NOT v_has_cron THEN
    RAISE NOTICE '[102] cron schema not present — skipping schedule step (manual invocation only)';
    RETURN;
  END IF;

  SELECT jobid INTO v_existing_jobid
    FROM cron.job
   WHERE jobname = 'content-dequeue-scheduled';
  IF v_existing_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(v_existing_jobid);
  END IF;
  PERFORM cron.schedule(
    'content-dequeue-scheduled',
    '*/15 * * * *',
    'SELECT content.dequeue_scheduled_topics()'
  );
END $$;

-- 8. Verification
DO $$
DECLARE
  v_extension_present BOOLEAN;
  v_function_present  BOOLEAN;
  v_cron_job_count    INTEGER;
  v_agent_present     BOOLEAN;
  v_rule_present      BOOLEAN;
  v_has_cron          BOOLEAN;
BEGIN
  SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_cron') INTO v_extension_present;
  SELECT EXISTS(
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname='content' AND p.proname='dequeue_scheduled_topics'
  ) INTO v_function_present;
  SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='cron') INTO v_has_cron;
  IF v_has_cron THEN
    SELECT count(*) INTO v_cron_job_count FROM cron.job WHERE jobname='content-dequeue-scheduled';
  ELSE
    v_cron_job_count := 0;
  END IF;
  SELECT EXISTS(SELECT 1 FROM agent_graph.agent_configs WHERE id='content-scheduler') INTO v_agent_present;
  SELECT EXISTS(
    SELECT 1 FROM agent_graph.agent_assignment_rules
     WHERE agent_id='content-scheduler' AND can_assign='executor-writer'
  ) INTO v_rule_present;

  RAISE NOTICE '[102] pg_cron installed:                  % (false=expected in CI/local)', v_extension_present;
  RAISE NOTICE '[102] dequeue_scheduled_topics() exists:   %', v_function_present;
  RAISE NOTICE '[102] cron job scheduled (1=prod, 0=CI):   %', v_cron_job_count;
  RAISE NOTICE '[102] content-scheduler agent_config:      %', v_agent_present;
  RAISE NOTICE '[102] content-scheduler->writer rule:      %', v_rule_present;
END $$;
