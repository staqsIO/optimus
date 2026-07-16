-- 157-capture-sources-owner-email.sql
-- OPT-101 (Feature 006 — Drive folder picker): add content.capture_sources.owner_email.
--
-- The watcher already consumes `source.owner_email || null` (watcher.js:570,635 →
-- getDriveClient(owner_email || null) / fetchDriveFileText(owner_email || null, ...)),
-- so this column is the storage half of the already-shipped read path. Zero watcher
-- change is required by this migration.
--
-- SECURITY (the crux of Feature 006 — see spec/features/006-drive-folder-picker.md §2):
--   owner_email is the workspace email the watcher IMPERSONATES (DWD) to READ a source.
--   Domain-wide delegation lets the SA impersonate ANY domain user, so this value is a
--   sensitive impersonation target. It is STAMPED SERVER-SIDE from the authenticated
--   board members.email at create time (resolveImpersonationEmail) — NEVER from the
--   request body, and it is NOT in the PATCH-key allowlist. A board user can only
--   register folders THEY can read.
--
--   NULL  = SA-direct: a Shared Drive the service account is a member of (no
--           impersonation at poll time). This is the existing OPT-98 behavior.
--   SET   = impersonate this workspace user via DWD to read the source bytes.
--
--   owner_email is ORTHOGONAL to owner_org_id: owner_email = WHOSE Drive we impersonate
--   to read the bytes; owner_org_id = WHICH tenant OWNS the resulting artifacts. Both
--   validate independently (a folder Eric reads can be attributed to the UMB org).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS. Nullable, no DEFAULT (null = SA-direct).
-- Raw parameterized DDL, no ORM. Runs best-effort at startup and against PGlite.

ALTER TABLE content.capture_sources
  ADD COLUMN IF NOT EXISTS owner_email TEXT;

COMMENT ON COLUMN content.capture_sources.owner_email IS
  'Feature 006 (OPT-101): workspace email the watcher impersonates (DWD) to READ this '
  'source. NULL = SA-direct (Shared Drive the SA is a member of). Set = personal/shared '
  'folder read via domain-wide-delegation impersonation. STAMPED server-side from the '
  'authenticated board_members.email at create time (resolveImpersonationEmail) — NEVER '
  'from the request body, and NOT in the PATCH-key allowlist. Orthogonal to owner_org_id '
  '(which tenant OWNS the captured artifacts).';
