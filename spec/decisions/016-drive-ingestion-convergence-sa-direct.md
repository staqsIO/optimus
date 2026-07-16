# Drive Ingestion Convergence: one registry, prefer SA-direct over DWD impersonation

> Authored 2026-06-03 (Eric directed convergence in session). Status: **PROPOSED**
> — needs board sign-off because it changes the blast radius of the Google
> service-account credential (a security boundary; see root CLAUDE.md "never
> present as final anything involving security boundaries"). Supersedes the
> implicit "two parallel Drive paths" state left after Feature 005 (OPT-96/97/98)
> shipped alongside the legacy folder-watch system.

## TL;DR / Recommendation

**Collapse the two Drive ingestion systems into one** — `content.capture_sources`
(the `/capture` registry) becomes the single source of Drive watches; the legacy
`inbox.drive_watches` + `SHARED_DRIVE_FOLDER_ID` path is retired after migrating
live rows.

**Invert the auth default: prefer service-account-direct membership (`sa_direct`)
over domain-wide-delegation (DWD) impersonation.** DWD is the broadest credential
in the system — one key can impersonate any user in the Workspace across
Drive/Gmail/Calendar. For org-owned **Shared Drives** (which have no personal
owner anyway) the narrowest correct access is to add the SA as a Viewer and read
as the SA — no impersonation, no domain-wide power exercised. DWD becomes an
explicit per-source fallback, not the everyday path.

## What actually exists today (cited)

| Concern | Legacy path | New path (Feature 005) |
|---|---|---|
| Registry | `inbox.drive_watches` (baseline `sql/001-baseline.sql:838`) + single env folder `SHARED_DRIVE_FOLDER_ID` | `content.capture_sources` (`sql/156`, `157`) |
| UI | Settings → "Drive Folder Watches" (`board/src/app/settings/page.tsx`, POST `/api/drive/watches`) | `/capture` (`board/src/app/capture/page.tsx`, OPT-102) |
| Boot poll | `pollSharedFolder()` only, env-gated (`src/index.js:335`) | `pollCaptureSources()` (`src/index.js:338`) |
| Per-watch poll | `pollAllDriveWatches()` (`watcher.js:178`) — **exported but never called in the boot loop**; only `backfillDriveWatch()` runs, via manual `/api/drive/watches/backfill` | continuous |
| Drive auth | `getDriveClient(email)` → SA + DWD | same `getDriveClient(email)` |

**Three decision-changing facts:**

1. **The legacy per-folder watch system is already half-dead.** `drive_watches`
   rows are written by the Settings UI but nothing polls them continuously —
   `pollAllDriveWatches()` has no caller in `src/index.js`. Only `pollSharedFolder()`
   (a single env-configured folder) and `pollCaptureSources()` run on the loop.
   Convergence is therefore mostly *deletion*, not a risky data migration.

2. **Both paths already funnel through the same SA+DWD client.** `watcher.js:171-174`
   explicitly states the linked Gmail account's own OAuth tokens are **not** used
   for Drive — every read goes through `getDriveClient()` (`src/drive/service-auth.js`),
   which impersonates via `subject` when an email is passed and reads as the SA
   when it isn't. SA-direct (`sa_direct`) is therefore already supported; it is
   just not the default.

3. **The Gmail OAuth grant already requests `drive.readonly`** (`src/gmail/auth.js:108`)
   but nothing consumes it for Drive. It is unused scope — a least-privilege
   liability — unless per-user OAuth Drive is deliberately adopted.

## Auth models, ranked by blast radius

| Model | Blast radius | Correct use |
|---|---|---|
| **SA-direct membership** (`getDriveClient(null)`) | Smallest — only drives explicitly shared to the SA email; revoke = remove membership; no domain power | **Org Shared Drives** |
| **Per-user OAuth** (`drive.readonly`) | Medium — one user's grant, user-revocable; but breaks on token revoke/expiry, sees only that user's view | **Personal My Drive** folders |
| **Service account + DWD** (`subject = email`) | Largest — impersonates any domain user across Drive/Gmail/Calendar; key leak = whole Workspace | Fallback only: a Shared Drive the SA can't be added to but a user can reach |

## Decision

1. **`content.capture_sources` is the single Drive ingestion registry.** Migrate
   any live `inbox.drive_watches` rows and the `SHARED_DRIVE_FOLDER_ID` folder
   into `capture_sources`, then remove `pollSharedFolder()`, `pollAllDriveWatches()`,
   the `SHARED_DRIVE_FOLDER_ID` env path, and the `/api/drive/watches*` routes.
   Repoint (or redirect) the Settings "Drive Folder Watches" section to `/capture`.

2. **Prefer `sa_direct`.** For a Shared Drive, `pollCaptureSources` tries
   `getDriveClient(null)` (SA membership) first and only impersonates
   (`getDriveClient(owner_email)`) when SA-direct returns not-found/forbidden.
   Record which path was used per source (`access` already modeled). The
   operational ask becomes "add the SA email as Viewer on the drives you want,"
   not "grant domain-wide delegation."

3. **Do not use DWD for personal folders by default.** Personal My Drive folders
   are captured by sharing the specific folder to the SA email (→ `sa_direct`) or
   via per-user OAuth — never blanket impersonation.

4. **Drop the unused `drive.readonly` Gmail scope** unless/until per-user OAuth
   Drive is adopted (least privilege). If per-user OAuth *is* adopted for personal
   folders, wire a `getDriveClient` variant that mints an OAuth2 client from the
   stored refresh token instead of `buildAuth(subject)`.

5. **Keep DWD as an explicit, audited fallback** — not removed (some drives are
   only reachable by impersonation), but never the silent default.

## Consequences

- **Smaller attack surface / cleaner security review.** The credential a review
  flags (domain-wide impersonation) stops being the everyday path. Each captured
  Shared Drive becomes an explicit, revocable membership grant.
- **One UI, one table, one poller.** Removes the "which Drive system is this?"
  ambiguity and the dead `pollAllDriveWatches` code.
- **Operational change:** going live now means *sharing drives to the SA email*
  rather than relying on DWD reach. Slightly more setup per drive, far less
  standing privilege. Document the SA email on the `/capture` page.
- **Migration risk is low** (legacy per-watch poll is already inert) but the
  `SHARED_DRIVE_FOLDER_ID` folder and any backfill-only watches must be ported or
  explicitly dropped, and tl;dv / Gemini transcript ingestion (which rides the
  Drive watcher) must be re-pointed at a `capture_sources` row.
- **Board review required** before Accepted: this narrows but also re-scopes how
  Optimus touches client Drive data.

## Open questions

1. Keep DWD provisioned at all, or remove the delegation grant from the SA once
   all live sources are `sa_direct`? (Removing it is the strongest posture but
   forecloses the impersonation fallback.)
2. Is per-user OAuth Drive worth wiring for personal folders, or do we mandate
   share-to-SA for everything and drop `drive.readonly` entirely?
3. tl;dv/Gemini transcript folders — port as first-class `capture_sources` rows
   with `kind='transcript'`, or keep a thin transcript-specific shim?

## Review: Liotta sequencing pass (2026-06-03)

Amendments folded in from the architecture review:

- **D1 is non-breaking — confirmed.** SA-direct-first then DWD-fallback reads a
  superset-or-equal set vs. today, so no board gate is needed until DWD is
  *removed*. **But the fallback MUST trigger on an explicit membership probe
  (`files.get` → 404/403), never on an empty changes feed.** A non-member
  SA-direct `changes.list` returns `200 + empty` (no throw), indistinguishable
  from "no new files" — a naive "fall back only on throw" would silently drop
  every file on an impersonated folder. Implemented exactly this way; a transient
  (5xx) probe error re-throws so the source stamps `last_error` and retries
  rather than silently flipping access.
- **Corrected ordering: D1 → D4 → D2 → D3.** D4 is bigger than "re-point" — the
  legacy `pollSharedFolder` path carries preset detection, `happenedAt` anchoring
  (`/today/meetings`), `webhook:<preset>` labels, and the triage work-item
  pipeline that `pollCaptureSource` does **not** yet have. `SHARED_DRIVE_FOLDER_ID`
  cannot be deleted (D2) until `capture_sources` reaches transcript parity (D4),
  or meeting transcripts go dark. **This is the load-bearing constraint.**
- **D2 scope correction:** `drive_watches` is **not** dead — five live HTTP routes
  (`GET/POST /api/drive/watches`, `/remove`, `/poll`, and `/api/drive/watches/backfill`).
  Only `pollAllDriveWatches()` is dead. D2 must delete all five routes +
  `backfillDriveWatch` together. Transcripts ride `pollSharedFolder`, not
  `drive_watches`.
- **D3 blocker:** `drive.readonly` is also consumed by an OAuth-Drive fallback at
  `src/api-routes/documents.js:476` (used only when `hasServiceAccount()` is
  false). Drop the scope from `gmail/auth.js` **and** that fallback together;
  safe only while "SA present" is invariant in prod.
- **`access_resolved` column adopted** (mig 158) as the P5 instrument. DWD-removal
  gate = `SELECT count(*) FROM content.capture_sources WHERE enabled AND
  access_resolved='impersonated'` must be 0.

## Implementation log

- **D1 — DONE** (commit on `worktree-drive-ingestion-convergence-adr`): `resolveDriveAccess()`
  membership probe + `access_resolved` (mig 158) + 3 tests (SA-direct preferred;
  404→DWD fallback still captures; 5xx holds `last_error`). 13/13 green.
- **Pre-existing bug fixed in the same commit:** the poll `SELECT` in
  `pollCaptureSources` omitted `owner_email`, so `source.owner_email` was always
  `undefined` and impersonation **never fired at poll time** (every source read
  SA-direct regardless of OPT-101's stamped value). `owner_email` is now selected.
  Side effect: this is the first time impersonation can actually engage at poll
  time — D1's SA-direct-first ordering means the *net* exposure still only
  narrows, but reviewers should note the latent path is now live.
- **D4 — DONE** (Option A: meeting-pipeline parity, not re-pointing the meetings
  UI). Extracted the legacy `pollDriveFolder` per-file pipeline into a shared
  `processTranscriptIntoMeeting()`; a `default_kind='transcript'` capture source
  now produces the same `/api/meetings` output (inbox.messages webhook row +
  `webhook:<preset>` labels + triage work_item + RAG) instead of an artifact.
  Tenancy: the writer stamps `owner_org_id` from the source row (REQUIRED —
  `/api/meetings` is org-scoped; `capture_sources.owner_org_id` is NOT NULL so
  the stamp always fires); the legacy path passes null → column DEFAULT (Staqs),
  unchanged. Linus pass: static INSERT SQL (no `cols.join`), `createWorkItem`
  wrapped so a failure can't thrash the cursor / orphan the message, empty-
  allowlist + no-id warnings. 16/16 watcher tests + meetings-api 21/21 green.
  **This unblocks D2.** Chosen Option A over re-pointing `/api/meetings` to read
  artifacts (Option B) to keep D4 scoped to "don't darken transcripts"; Option B
  (single representation, drop the inbox.messages dual-write) remains a future
  cleanup.
- **D2 — DONE** (PR #351, branch `opt-103-d2-retire-legacy-drive`). Retired the
  legacy Drive path entirely — `capture_sources` is now the only Drive ingestion.
  Prod-verified safe: `inbox.drive_watches` had 0 rows, `pollAllDriveWatches` was
  never booted, and `SHARED_DRIVE_FOLDER_ID` was confirmed dead in Railway (Eric).
  Removed `pollSharedFolder`/`pollAllDriveWatches`/`pollDriveFolder`/
  `backfillDriveWatch`, the 4 `/api/drive/watches*` routes, the `drive_watches`
  read in `/api/transcripts/status`, and the "Drive Folder Watches" UI in the
  board + legacy dashboard (→ `/capture` tombstone). Linus pass caught 2 BLOCKERs
  (legacy dashboard at port 3100 + a broken dev script my grep scope missed) —
  fixed; repo-wide sweep now zero. Kept: tl;dv path (independent), the `/api/drive`
  prefix (surviving OPT-101 picker routes), and the empty `drive_watches` table
  (no destructive DDL). ~850 deletions. **The two-parallel-systems state is gone.**
- **D3 — not started** (independent): drop unused `drive.readonly` from
  `gmail/auth.js` + the `documents.js:476` OAuth-Drive fallback.
- Net: D1 + D4 merged (#350); D2 on #351. Convergence to a single registry is
  done; only the least-privilege scope drop (D3) and the board-gated DWD removal
  remain.
