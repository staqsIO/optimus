-- 021-wiki-compile.sql
-- Wiki compilation tracking for LLM-compiled wiki articles.
--
-- Adds compile_status to content.documents so the compiler knows which
-- vault docs need compilation and which are already compiled output.
-- Anti-circular-ingestion: wiki-compiled docs are marked 'skip' so they
-- never re-enter the compilation pipeline.

-- Compile status: NULL = not applicable, 'pending' = needs compilation,
-- 'compiled' = has been compiled into wiki articles, 'skip' = is itself a wiki article
ALTER TABLE content.documents ADD COLUMN IF NOT EXISTS compile_status TEXT DEFAULT NULL
  CHECK (compile_status IN ('pending', 'compiled', 'skip'));

-- Source document IDs that a compiled article was built from
ALTER TABLE content.documents ADD COLUMN IF NOT EXISTS compiled_from TEXT[] DEFAULT NULL;

-- Index for finding pending documents efficiently
CREATE INDEX IF NOT EXISTS idx_documents_compile_pending
  ON content.documents(compile_status) WHERE compile_status = 'pending';

-- Index for finding compiled articles
CREATE INDEX IF NOT EXISTS idx_documents_wiki_compiled
  ON content.documents(source) WHERE source = 'wiki-compiled';

-- Mark all existing vault documents as pending compilation
UPDATE content.documents SET compile_status = 'pending'
  WHERE source = 'vault' AND compile_status IS NULL;
