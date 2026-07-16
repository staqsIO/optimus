-- Phase 4 of the CRM upgrade: deals + tags.
--
-- Deals are the unit of pipeline tracking — one row per "thing in flight"
-- with a stage (prospect→won/lost). Tags are free-form labels per contact
-- so we can slice the contact list by anything we like (e.g. 'investor',
-- 'q3-outreach', 'demo-scheduled') without inventing a new enum each time.
--
-- saved_views deferred until we hit the friction.

CREATE TABLE IF NOT EXISTS signal.deals (
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  contact_id        TEXT NOT NULL,                                       -- primary contact (intra-schema)
  organization_id   TEXT REFERENCES signal.organizations(id) ON DELETE SET NULL,
  title             TEXT NOT NULL,
  stage             TEXT NOT NULL DEFAULT 'prospect'
                      CHECK (stage IN ('prospect', 'qualified', 'proposal',
                                       'negotiation', 'won', 'lost', 'churned')),
  value_usd         NUMERIC(12, 2),
  expected_close    DATE,
  notes             TEXT,
  metadata          JSONB,
  created_by        TEXT,                                                -- board user that opened the deal
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at         TIMESTAMPTZ,
  closed_reason     TEXT
);

CREATE INDEX IF NOT EXISTS deals_contact_idx ON signal.deals (contact_id);
CREATE INDEX IF NOT EXISTS deals_org_idx
  ON signal.deals (organization_id) WHERE organization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS deals_stage_idx ON signal.deals (stage);
CREATE INDEX IF NOT EXISTS deals_open_idx
  ON signal.deals (last_activity_at DESC)
  WHERE stage NOT IN ('won', 'lost', 'churned');

-- Touch trigger.
CREATE OR REPLACE FUNCTION signal.touch_deal_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  IF NEW.stage IS DISTINCT FROM OLD.stage THEN
    NEW.last_activity_at := now();
    -- Auto-stamp closed_at when entering a terminal stage; clear on reopen.
    IF NEW.stage IN ('won', 'lost', 'churned') AND NEW.closed_at IS NULL THEN
      NEW.closed_at := now();
    ELSIF NEW.stage NOT IN ('won', 'lost', 'churned') THEN
      NEW.closed_at := NULL;
      NEW.closed_reason := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS deals_touch_updated_at ON signal.deals;
CREATE TRIGGER deals_touch_updated_at
  BEFORE UPDATE ON signal.deals
  FOR EACH ROW EXECUTE FUNCTION signal.touch_deal_updated_at();

-- Free-form tags per contact. (contact_id, tag) is the natural PK; no
-- separate id column needed since we never reference a tag row from
-- elsewhere.
CREATE TABLE IF NOT EXISTS signal.contact_tags (
  contact_id   TEXT NOT NULL,
  tag          TEXT NOT NULL CHECK (length(tag) BETWEEN 1 AND 64),
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_id, tag)
);

CREATE INDEX IF NOT EXISTS contact_tags_tag_idx ON signal.contact_tags (tag);
