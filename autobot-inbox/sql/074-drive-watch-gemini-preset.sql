-- 074: document the Gemini preset for Drive watches
--
-- The `preset` column on inbox.drive_watches is a free-form TEXT (no CHECK
-- constraint) — validation lives in the API layer. This migration just
-- updates the column comment so anyone reading the schema sees that gemini
-- is now a valid preset alongside tldv/generic.

COMMENT ON COLUMN inbox.drive_watches.preset IS
  'Optional preset: tldv (meeting transcripts), gemini (Google Meet "Notes by Gemini" docs), generic, or NULL.';
