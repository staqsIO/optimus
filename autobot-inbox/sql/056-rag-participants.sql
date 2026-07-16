-- 056: Participant-aware RAG (Phase 1).
--
-- Problem: asking "what happened in the meeting with John" returns nothing when
-- John attended but never said his own name inside a chunk. tl;dv speaker info
-- lives on content.chunks.metadata.speakers[] but retrieval has no way to
-- filter or boost by it, and non-transcript sources drop participants entirely.
--
-- This migration:
--   1. Adds a structured `participants` JSONB column to content.documents.
--   2. Indexes it with jsonb_path_ops for fast `@>` containment lookups.
--   3. Adds a GIN index on content.chunks.metadata so speaker queries work.
--   4. Relaxes signal.contacts CHECK constraint so ingest-time auto-created
--      contacts can use contact_type='participant' without silent failures
--      (fixes a latent bug in src/transcripts/action-extractor.js).

-- 1. Document-level participants
ALTER TABLE content.documents
  ADD COLUMN IF NOT EXISTS participants JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN content.documents.participants IS
  'Array of { contact_id: UUID|null, name: string, email: string|null, role: string, confidence: string }. Populated by lib/rag/participants/resolver.js at ingest time.';

-- 2. Indexes
-- jsonb_path_ops supports the @> operator (containment) and has a much smaller
-- footprint than the default jsonb_ops. This is our primary access path.
CREATE INDEX IF NOT EXISTS idx_documents_participants_gin
  ON content.documents USING GIN (participants jsonb_path_ops);

CREATE INDEX IF NOT EXISTS idx_chunks_metadata_gin
  ON content.chunks USING GIN (metadata jsonb_path_ops);

-- 3. Expand signal.contacts.contact_type to include 'participant' (meeting/thread
-- attendees that haven't been classified further). Drop+recreate the CHECK
-- constraint since Postgres doesn't support ALTER CHECK.
ALTER TABLE signal.contacts
  DROP CONSTRAINT IF EXISTS contacts_contact_type_check;

ALTER TABLE signal.contacts
  ADD CONSTRAINT contacts_contact_type_check
  CHECK (contact_type IN (
    'cofounder', 'board', 'investor',
    'team', 'advisor', 'customer', 'prospect', 'partner',
    'vendor', 'legal', 'accountant',
    'recruiter',
    'service', 'newsletter',
    'participant',
    'unknown'
  ));

-- 4. Helpful secondary indexes for the resolver's hot path
CREATE INDEX IF NOT EXISTS idx_contacts_name_lower
  ON signal.contacts (lower(name));

CREATE INDEX IF NOT EXISTS idx_contacts_email_lower
  ON signal.contacts (lower(email_address));
