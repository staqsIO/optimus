-- 008: Voice profile source — allows accounts to share voice profiles
-- jamie@staqs.io can use eric@staqs.io's voice profile for consistent tone
-- across all company email accounts.

ALTER TABLE inbox.accounts
  ADD COLUMN IF NOT EXISTS voice_profile_source TEXT;

COMMENT ON COLUMN inbox.accounts.voice_profile_source IS
  'Account ID whose voice profiles this account should use. NULL = use own profiles. Enables shared voice across multiple email accounts (e.g., jamie uses eric''s voice).';

-- Set jamie to use eric's voice profile
UPDATE inbox.accounts
  SET voice_profile_source = (
    SELECT id FROM inbox.accounts WHERE identifier = 'eric@staqs.io' LIMIT 1
  )
  WHERE identifier = 'jamie@staqs.io';
