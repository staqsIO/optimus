-- 006: Add owner column to inbox.accounts for multi-user support.
-- Tracks which board member connected each account (GitHub username).
-- Settings page filters accounts by owner. Existing accounts default to 'ecgang'.

ALTER TABLE inbox.accounts
  ADD COLUMN IF NOT EXISTS owner TEXT;

-- Backfill existing accounts to Eric (the only user who has connected accounts so far)
UPDATE inbox.accounts SET owner = 'ecgang' WHERE owner IS NULL;

COMMENT ON COLUMN inbox.accounts.owner IS 'Board member GitHub username who connected this account';
