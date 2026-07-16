-- 049: Voice profile platform extension for unified content engine (Phase 1.5)
-- Extends voice.profiles to support per-platform tone matching (email/blog/linkedin).
-- Adds content_author scope for per-author voice profiles across platforms.

-- 1. Add platform column to voice.profiles
-- Default 'email' preserves all existing profiles unchanged.
ALTER TABLE voice.profiles
  ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'email'
  CHECK (platform IN ('email', 'blog', 'linkedin', 'all'));

-- 2. Add author_id column for per-author content profiles
-- NULL for email profiles (keyed by account_id instead).
-- For content, this is the author name (e.g., 'Eric Gang', 'Dustin Powers').
ALTER TABLE voice.profiles
  ADD COLUMN IF NOT EXISTS author_id TEXT;

-- 3. Drop and recreate the unique index to include platform
-- The old index: (scope, scope_key, account_id)
-- The new index: (scope, scope_key, account_id, platform)
-- This allows the same scope+key to have different profiles per platform.
DROP INDEX IF EXISTS voice.profiles_scope_key_account_unique;
CREATE UNIQUE INDEX profiles_scope_key_account_platform_unique
  ON voice.profiles (
    scope,
    COALESCE(scope_key, '__null__'),
    COALESCE(account_id, '__global__'),
    platform
  );

-- 4. Add 'content' scope type for content-specific voice profiles
-- Extends the existing scope check to include content-specific scopes.
ALTER TABLE voice.profiles
  DROP CONSTRAINT IF EXISTS profiles_scope_check;
ALTER TABLE voice.profiles
  ADD CONSTRAINT profiles_scope_check
  CHECK (scope IN ('global', 'recipient', 'topic', 'content'));

-- 5. Index for quick author+platform lookups (content pipeline hot path)
CREATE INDEX IF NOT EXISTS idx_voice_profiles_author_platform
  ON voice.profiles(author_id, platform) WHERE author_id IS NOT NULL;
