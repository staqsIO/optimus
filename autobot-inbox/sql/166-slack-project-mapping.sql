-- 166-slack-project-mapping.sql
-- OPT-46: Slack channel ↔ project/engagement mapping (per-org join table).
--
-- Design (P1/P2/P4, mirrors capture-sources pattern):
--   - org_id NOT NULL, stamped from validated tenancy.orgs row, never body.
--   - A Slack channel may map to EITHER a project (agent_graph.projects) OR an
--     engagement (engagements.engagements) — exactly one per mapping row via
--     entity_type CHECK constraint.
--   - UNIQUE (org_id, slack_channel_id): one entity per channel per org.
--     Remap = DELETE old row + INSERT new row.
--   - No cross-schema FKs (SPEC §12): entity_type + entity_id carry the ref;
--     handler validates entity exists before insert.
--   - Raw parameterized SQL, no ORM. Idempotent. Runs against PGlite.
--
-- Lives in `inbox` schema (collocated with per-org operational tables).

CREATE TABLE IF NOT EXISTS inbox.slack_project_map (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL,           -- tenancy.orgs.id; never from untrusted body
  slack_channel_id   TEXT NOT NULL,           -- Slack channel ID (C01ABC123)
  slack_channel_name TEXT,                    -- human label (best-effort; may lag)
  entity_type        TEXT NOT NULL
    CHECK (entity_type IN ('project', 'engagement')),
  entity_id          TEXT NOT NULL,           -- agent_graph.projects.id OR engagements.engagements.id
  created_by         TEXT,                    -- board_members handle or agent id
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One channel → at most one entity per org.
CREATE UNIQUE INDEX IF NOT EXISTS uq_slack_project_map_org_channel
  ON inbox.slack_project_map (org_id, slack_channel_id);

-- Fast entity lookup (find all channels mapped to a project/engagement).
CREATE INDEX IF NOT EXISTS idx_slack_project_map_entity
  ON inbox.slack_project_map (entity_type, entity_id);

-- Fast org listing.
CREATE INDEX IF NOT EXISTS idx_slack_project_map_org
  ON inbox.slack_project_map (org_id);

-- updated_at trigger
CREATE OR REPLACE FUNCTION inbox.touch_slack_project_map_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS slack_project_map_touch_updated_at ON inbox.slack_project_map;
CREATE TRIGGER slack_project_map_touch_updated_at
  BEFORE UPDATE ON inbox.slack_project_map
  FOR EACH ROW EXECUTE FUNCTION inbox.touch_slack_project_map_updated_at();

-- Verification
DO $$
DECLARE
  v_count INT;
BEGIN
  SELECT count(*) INTO v_count
    FROM information_schema.tables
   WHERE table_schema = 'inbox' AND table_name = 'slack_project_map';
  RAISE NOTICE '[166] slack_project_map: % row (expect 1)', v_count;
END $$;
