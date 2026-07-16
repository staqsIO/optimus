-- Speaker voiceprints for transcript identification.
--
-- Each row is one Picovoice Eagle profile bound to a signal.contacts row.
-- The profile is opaque bytes returned by EagleProfiler.export() — we never
-- inspect it, just hand it back to Eagle at match time. ~10KB per profile.
--
-- One contact -> one voiceprint (UNIQUE on contact_id). Re-enrollment
-- replaces the existing profile via UPSERT in the API layer.

CREATE TABLE IF NOT EXISTS voice.voice_prints (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  contact_id      TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  profile         BYTEA NOT NULL,
  picovoice_version TEXT,
  sample_seconds  REAL,
  enrolled_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  enrolled_by     TEXT,

  CONSTRAINT voice_prints_contact_unique UNIQUE (contact_id)
);

-- No cross-schema FK per SPEC §12 — contact_id is validated at the application layer.
CREATE INDEX IF NOT EXISTS voice_prints_enrolled_at_idx ON voice.voice_prints (enrolled_at DESC);
