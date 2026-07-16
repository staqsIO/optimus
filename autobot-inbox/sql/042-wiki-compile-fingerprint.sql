-- Track source bundle fingerprint to skip redundant wiki compiles when sources unchanged.
ALTER TABLE content.wiki_pages ADD COLUMN IF NOT EXISTS compile_source_fingerprint TEXT;
