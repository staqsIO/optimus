-- STAQPRO-308 Phase 2 — generalize the Phase 1 one-shot Don/Nicholas split into a
-- board-callable SQL function backing POST /api/contacts/:id/split-identities.
--
-- Mirrors signal.merge_contacts in style; uses signal.contact_merge_log (which
-- already has 'split' in its CHECK constraint).
--
-- Linus pre-implementation review notes incorporated:
--   1. SELECT FOR UPDATE on the source contact at the top to serialize concurrent
--      splits on the same source (Linus BLOCKER #1).
--   2. SECURITY INVOKER — board-tier check is enforced at the HTTP layer; the role
--      executing the function is what RLS / GRANTs see, so PR-B's autobot_agent
--      role switch works as intended (Linus SHOULD-FIX #6).
--   3. In-function assertion that p_primary_email is one of p_identity_ids
--      identifiers AND channel='email'. Defense-in-depth — does not trust the
--      API layer's validation (Linus NIT #4).
--   4. emails_sent is recomputed from voice.sent_emails ground truth.
--      emails_received is NOT recomputed — no equivalent ground-truth source
--      exists, and overwriting with a wrong value is worse than leaving stale
--      (Linus SHOULD-FIX #3). The source retains its pre-split emails_received;
--      the new contact starts at 0.
--   5. autobot_public.event_log row emitted on success (Linus SHOULD-FIX #5).
--   6. Explicit GRANT EXECUTE for autobot_agent at the bottom — the catch-all
--      GRANT in 001-baseline.sql:2801 runs at migration time and does not cover
--      functions created later.

-- Extend the autobot_public.event_log event_type whitelist to admit the new
-- 'contact_split' (and 'contact_merged' for symmetry with /merge, which today
-- writes nothing to the public stream — that gap is a separate ticket).
--
-- Also admit the 'campaign_*' lifecycle event types that the claw-campaigner
-- runtime has been writing since the Campaign overhaul (2026-04-04). Audit
-- on 2026-05-14 counted 442 such rows already in production; without these
-- entries in the whitelist the constraint validation step at the bottom of
-- this migration fails on every boot, leaving 106 chronically pending in
-- public._migrations.
--
-- STAQPRO-314: this list MUST be a strict SUPERSET of the baseline final
-- event_log_event_type_check (001-baseline.sql ~L5860). An earlier draft of
-- this migration silently dropped six values the baseline already allows
-- (intent_approved, intent_rejected, exploration_cycle, exploration_finding,
-- workshop_succeeded, workshop_failed). Existing rows of those types — written
-- by the claw/intent runtime since 2026-03-31 — then failed ADD CONSTRAINT,
-- so 106 never applied on any fresh DB (PGlite migrate) or in prod. Narrowing
-- this set is a regression: only ever add, never remove.
ALTER TABLE autobot_public.event_log
  DROP CONSTRAINT IF EXISTS event_log_event_type_check;
ALTER TABLE autobot_public.event_log
  ADD CONSTRAINT event_log_event_type_check CHECK (event_type IN (
    'email_received', 'email_triaged', 'draft_created', 'draft_reviewed',
    'draft_approved', 'draft_sent', 'halt_triggered', 'halt_cleared',
    'budget_warning', 'autonomy_evaluation', 'config_changed',
    'board_directive', 'infrastructure_error',
    'redesign_submitted', 'redesign_completed',
    'blueprint_submitted', 'blueprint_completed',
    'intent_executed', 'intent_approved', 'intent_rejected',
    'agent_insight',
    'contact_split', 'contact_merged',
    'campaign_started', 'campaign_iteration', 'campaign_completed',
    'campaign_paused', 'campaign_cancelled',
    'exploration_cycle', 'exploration_finding',
    'workshop_succeeded', 'workshop_failed'
  ));

CREATE OR REPLACE FUNCTION signal.split_contact_identities(
  p_source_id         text,
  p_identity_ids      text[],
  p_new_name          text,
  p_primary_email     text,
  p_organization      text DEFAULT NULL,
  p_contact_type      text DEFAULT 'unknown',
  p_tier              text DEFAULT 'active',
  p_reason            text DEFAULT 'manual split',
  p_performed_by      text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_source_locked    text;
  v_source_count     int;
  v_moving_count     int;
  v_primary_in_set   int;
  v_existing_target  text;
  v_new_id           text;
  v_moved_idents     text[];
  v_moved_emails     text[];
  v_kept_emails      text[];
  v_new_emails_sent  int;
  v_src_emails_sent  int;
BEGIN
  -- 0. Required params.
  IF p_source_id IS NULL OR p_identity_ids IS NULL OR array_length(p_identity_ids, 1) IS NULL
     OR p_new_name IS NULL OR p_new_name = '' OR p_primary_email IS NULL OR p_primary_email = '' THEN
    RAISE EXCEPTION 'split_contact_identities: missing required parameter(s)';
  END IF;
  IF p_performed_by IS NULL OR p_performed_by = '' THEN
    RAISE EXCEPTION 'split_contact_identities: p_performed_by required for audit';
  END IF;

  -- 1. Lock source contact row to serialize concurrent splits / merges.
  SELECT id INTO v_source_locked
    FROM signal.contacts WHERE id = p_source_id FOR UPDATE;
  IF v_source_locked IS NULL THEN
    RAISE EXCEPTION 'split_contact_identities: source contact % not found', p_source_id;
  END IF;

  -- 2. Identities being moved must all currently belong to the source.
  SELECT count(*), count(*) FILTER (
    WHERE channel = 'email' AND LOWER(identifier) = LOWER(p_primary_email)
  )
    INTO v_moving_count, v_primary_in_set
    FROM signal.contact_identities
   WHERE id = ANY(p_identity_ids) AND contact_id = p_source_id;

  IF v_moving_count <> COALESCE(array_length(p_identity_ids, 1), 0) THEN
    RAISE EXCEPTION
      'split_contact_identities: % of % identity_ids are not owned by source %',
      COALESCE(array_length(p_identity_ids, 1), 0) - v_moving_count,
      COALESCE(array_length(p_identity_ids, 1), 0),
      p_source_id;
  END IF;

  -- 3. Primary email must be one of the identities being moved (and channel=email).
  IF v_primary_in_set = 0 THEN
    RAISE EXCEPTION
      'split_contact_identities: p_primary_email % is not among the email identities being moved',
      p_primary_email;
  END IF;

  -- 4. Source must retain at least one identity after the split.
  SELECT count(*) INTO v_source_count
    FROM signal.contact_identities
   WHERE contact_id = p_source_id;
  IF v_source_count - v_moving_count < 1 THEN
    RAISE EXCEPTION
      'split_contact_identities: split would orphan source contact (% identities total, % moving). Use delete-contact instead.',
      v_source_count, v_moving_count;
  END IF;

  -- 5. No existing contact at p_primary_email.
  SELECT id INTO v_existing_target
    FROM signal.contacts
   WHERE LOWER(email_address) = LOWER(p_primary_email)
   LIMIT 1;
  IF v_existing_target IS NOT NULL THEN
    RAISE EXCEPTION
      'split_contact_identities: a contact already exists at email %: %',
      p_primary_email, v_existing_target;
  END IF;

  -- 6. Compute new-side / source-side email identifier sets for counter recompute.
  SELECT array_agg(LOWER(identifier)) INTO v_moved_emails
    FROM signal.contact_identities
   WHERE id = ANY(p_identity_ids) AND channel = 'email';

  SELECT array_agg(LOWER(identifier)) INTO v_kept_emails
    FROM signal.contact_identities
   WHERE contact_id = p_source_id
     AND channel = 'email'
     AND NOT (id = ANY(p_identity_ids));

  -- 7. INSERT the new contact.
  --    The contacts_sync_email_identity trigger fires AFTER INSERT and tries to
  --    INSERT an identity for p_primary_email. The identifier already exists on
  --    the source contact at this point — ON CONFLICT (channel, identifier) DO
  --    NOTHING leaves the source-owned row intact; we re-point it in step 8.
  INSERT INTO signal.contacts (
    email_address, name, organization, contact_type, tier,
    emails_sent, last_sent_at, source_account_id, metadata, created_at, updated_at
  ) VALUES (
    p_primary_email,
    p_new_name,
    p_organization,
    COALESCE(p_contact_type, 'unknown'),
    COALESCE(p_tier, 'active'),
    0,
    (SELECT max(sent_at) FROM voice.sent_emails
      WHERE LOWER(to_address) = ANY(v_moved_emails)),
    NULL,
    jsonb_build_object(
      'created_by',           'signal.split_contact_identities',
      'split_from_contact_id', p_source_id,
      'split_reason',          p_reason,
      'split_at',              now()
    ),
    now(), now()
  )
  RETURNING id INTO v_new_id;

  -- 8. Move the identities. Defense-in-depth: WHERE clause requires source
  --    ownership, so cross-contact theft is impossible even if validation slipped.
  UPDATE signal.contact_identities
     SET contact_id = v_new_id
   WHERE id = ANY(p_identity_ids)
     AND contact_id = p_source_id;

  SELECT array_agg(identifier ORDER BY identifier) INTO v_moved_idents
    FROM signal.contact_identities
   WHERE contact_id = v_new_id AND id = ANY(p_identity_ids);

  -- 9. Recompute emails_sent ground truth (only — emails_received has no
  --    equivalent source, see Linus SHOULD-FIX #3 above).
  SELECT count(*)::int INTO v_new_emails_sent
    FROM voice.sent_emails
   WHERE LOWER(to_address) = ANY(v_moved_emails);

  SELECT count(*)::int INTO v_src_emails_sent
    FROM voice.sent_emails
   WHERE LOWER(to_address) = ANY(COALESCE(v_kept_emails, ARRAY[]::text[]));

  UPDATE signal.contacts SET emails_sent = v_new_emails_sent, updated_at = now()
   WHERE id = v_new_id;
  UPDATE signal.contacts SET emails_sent = v_src_emails_sent, updated_at = now()
   WHERE id = p_source_id;

  -- 10. Append-only audit (matches contact_merge_log operation IN ('merge', 'split')).
  INSERT INTO signal.contact_merge_log
    (operation, primary_id, secondary_id, reason, performed_by, identities_moved)
  VALUES
    ('split', p_source_id, v_new_id, p_reason, p_performed_by,
     COALESCE(v_moved_idents, '{}'));

  -- 11. Public event (P3 transparency by structure). Plain INSERT to mirror
  --     existing helper paths at sql/001-baseline.sql:1970/1981.
  INSERT INTO autobot_public.event_log (event_type, summary, metadata)
  VALUES (
    'contact_split',
    format('split %s identities from contact %s to new contact %s',
           v_moving_count, p_source_id, v_new_id),
    jsonb_build_object(
      'source_id',         p_source_id,
      'new_id',            v_new_id,
      'identities_moved',  COALESCE(v_moved_idents, '{}'),
      'reason',            p_reason,
      'performed_by',      p_performed_by
    )
  );

  RETURN jsonb_build_object(
    'split',              true,
    'source_id',          p_source_id,
    'new_id',             v_new_id,
    'identities_moved',   COALESCE(v_moved_idents, '{}'),
    'source_emails_sent', v_src_emails_sent,
    'new_emails_sent',    v_new_emails_sent
  );
END;
$$;

COMMENT ON FUNCTION signal.split_contact_identities(
  text, text[], text, text, text, text, text, text, text
) IS 'STAQPRO-308 Phase 2: split N identities off a source contact into a new contact. Atomic; FOR-UPDATE-locks source; recomputes emails_sent from voice.sent_emails ground truth; logs to signal.contact_merge_log (operation=split) and autobot_public.event_log.';

-- Explicit GRANT for the autobot_agent role (PR-B forward compat). The
-- baseline GRANT EXECUTE ON ALL FUNCTIONS ran at migration time; functions
-- created later need explicit grants.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'autobot_agent') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION signal.split_contact_identities(
      text, text[], text, text, text, text, text, text, text
    ) TO autobot_agent';
  END IF;
END $$;
