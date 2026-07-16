# Feature 006 — Drive Folder Picker (self-serve capture-source registration)

Status: DRAFT (architecture pass, Liotta 2026-06-03)
Builds on: Feature 005 (capture sources), OPT-96/97/98. Backend watcher is impersonation-ready.

## Summary
A board management page where a board user browses their **Shared Drives + personal
My-Drive folders**, picks folders to sync, assigns each an owning org + default kind +
file-type allowlist, and sees status. Self-serve front-end for the already-shipped
`content.capture_sources` registry. The hard part is the **impersonation security model**,
not the UI.

---

## 1. THE IMPERSONATION SECURITY MODEL (the crux)

DWD (`buildAuth` sets `opts.subject = userEmail`) lets the SA impersonate **any** domain
user. If the impersonated email came from a request param, a board user could list (and
later register a sync of) **another user's private Drive**. That is the 588/596 leak class
in impersonation form. The rule is absolute:

> **The impersonated workspace email is derived server-side from the authenticated
> identity. It is NEVER read from a request param, header, or body.**

### Derivation mechanism (reuse, no new mapping needed)
The mapping already exists. `agent_graph.board_members` has `email TEXT`, and
`req.auth.github_username` is set by the board JWT (api.js:231) or the ops-proxy
`X-Board-User` header (api.js:263). The derivation is exactly the existing
`requireBoardAdmin` shape (api.js:298), returning email instead of id:

```
async function resolveImpersonationEmail(req):
  if req.auth?.role !== 'board' or !req.auth.github_username -> 403   // P1 deny-by-default
  row = SELECT email FROM agent_graph.board_members
        WHERE github_username = $1 AND is_active = true LIMIT 1
  if !row or !row.email -> 403  (no resolvable workspace identity)
  return row.email
```

- **Enforced inside each Drive-listing handler and at source-create**, after
  `requireBoardHuman(req)`. The handler computes the email; the client never supplies it.
- A bare `api_secret` board caller (no `github_username`) → **403**, not SA-direct.
  Self-serve folder picking requires a *human* identity to impersonate; an
  identity-less secret has no Drive to browse. (Contrast `requireBoardAdmin`, which
  admits identity-less api_secret — do NOT copy that branch here.)

### Domain constraint (a real finding, must handle)
`board_members.email` for Dustin is `dustin@example.com` — a **personal address,
not a Workspace-domain identity**. DWD impersonation only works for users in the SA's
delegated Workspace domain (`@staqs.io` and any other domains the SA is authorized for).
Impersonating a non-domain email returns a Google `unauthorized_client` / 403.

Decision: **fail closed with a clear 4xx**, do not fall back to SA-direct. Map the Google
error to `400 {error:'impersonation_unavailable', detail:'<email> is not a delegated
Workspace user'}`. A user whose `board_members.email` is non-domain simply cannot use the
personal-folder picker (they can still register Shared Drives the SA is a member of via a
separate, no-impersonation path — see §3). This is correct: we should not let someone
browse a domain they don't belong to, and we should not silently widen scope.

---

## 2. `owner_email` on capture_sources (migration 157)

```sql
ALTER TABLE content.capture_sources
  ADD COLUMN IF NOT EXISTS owner_email TEXT;  -- nullable
COMMENT ON COLUMN content.capture_sources.owner_email IS
  'Feature 006: workspace email the watcher impersonates to READ this source. '
  'NULL = SA-direct (Shared Drive the SA is a member of). Set = personal/shared '
  'folder read via DWD impersonation. STAMPED server-side from the authenticated '
  'board members.email at create time — NEVER from the request body. Orthogonal to '
  'owner_org_id (which tenant OWNS the captured artifacts).';
```

- **Nullable.** `null` = SA-direct (existing OPT-98 behavior; watcher passes
  `source.owner_email || null` → `getDriveClient(null)`). Set = impersonate.
- **Who may set it, and to what: only the authenticated picker's own resolved email.**
  `owner_email` is NOT in the PATCH-key allowlist and NOT read from the create body. The
  create handler stamps it from `resolveImpersonationEmail(req)`. A board user can only
  register folders **they** can read. An admin "register on behalf of another user"
  override is a deliberate, separate, later concern (would need its own gate + audit).
- **Watcher already consumes it** (watcher.js:570,635: `getDriveClient(source.owner_email
  || null)`, `fetchDriveFileText(source.owner_email || null, ...)`). **Zero watcher
  change.** Add: on a Google impersonation error during poll, write `last_error` and
  hold the cursor (existing cursor-hold-on-error path), don't crash the batch.
- **`owner_email` ⟂ `owner_org_id` — confirmed orthogonal.** `owner_email` = *whose
  Drive we impersonate to read the bytes*. `owner_org_id` = *which tenant owns the
  resulting artifacts*. Eric can register a folder he reads (`owner_email=eric@staqs.io`)
  whose captures belong to the UMB org (`owner_org_id=<umb>`). Both must validate
  independently.

---

## 3. Drive-listing endpoints (board-human gated, read Google not org data)

Both gated by `requireBoardHuman(req)` then `resolveImpersonationEmail(req)`. They list
the **authenticated caller's own** Google Drive structure — there is no org-data tenancy
to scope (it's Google's ACL doing the scoping via the impersonated identity), but they
are still board-human-only because they expose Drive structure.

### GET /api/drive/shared-drives
- `drive.drives.list({ pageSize, pageToken, fields:'nextPageToken,drives(id,name)' })`
  impersonating the resolved email.
- Two-source merge: also surface Shared Drives the **SA itself** is a member of
  (`getDriveClient(null).drives.list`) — these are registrable with `owner_email=null`
  (no impersonation needed at poll time). Tag each row `{ access:'impersonated' |
  'sa_direct' }` so the create step knows whether to stamp `owner_email`.
- Response: `{ drives:[{id,name,access}], nextPageToken }`.

### GET /api/drive/folders?parent=<id|'root'>&driveId=<optional>
- `drive.files.list({ q:"mimeType='application/vnd.google-apps.folder' and '<parent>' in
  parents and trashed=false", pageSize, pageToken, fields:'nextPageToken,files(id,name,
  parents)', supportsAllDrives:true, includeItemsFromAllDrives:true, corpora:'drive'|'user',
  driveId })` impersonating the resolved email. `parent='root'` → My-Drive root.
- Response: `{ folders:[{id,name}], nextPageToken, parent }`.

### Error handling (4xx, never 500)
- DWD not configured / no SA key → `503 {error:'drive_unavailable'}`.
- Impersonation rejected by Google (non-domain user, SA not authorized) →
  `400 {error:'impersonation_unavailable'}`.
- Caller not board-human → `403`. Map googleapis thrown errors centrally; never leak a
  raw 500 with a Google stack.

---

## 4. Tenancy rules on source creation

`POST /api/capture-sources` (existing handler, extended):
1. `requireBoardHuman(req)`.
2. `owner_email` = `resolveImpersonationEmail(req)` **iff** the picked source needs
   impersonation (`access:'impersonated'`); else `null` for `access:'sa_direct'`.
   Never from body.
3. `owner_org_id` = body, validated via existing `assertKnownOrg`. **Additionally**:
   constrain to an org the caller **belongs to** (membership check against
   `tenancy.org_members` for `board_members.id`), unless caller is board-admin
   (`role:'admin'` may pick any org). Today's handler validates org *exists* but not
   *membership* — tighten it here (a member shouldn't attribute captures to an org they
   aren't in).
4. Global `UNIQUE(source_type, external_id)` still applies → second claim of a folder = **409**.
5. `created_by` = `github_username` (existing).

---

## 5. Risks / tradeoffs / decomposition

### Top 3 risks
1. **Param-sourced impersonation email (the leak).** Mitigation: derivation is
   server-side from `board_members.email`; `owner_email` excluded from body + PATCH
   allowlist; add a regression test asserting a body-supplied `owner_email`/`impersonate`
   param is ignored. This is the one thing that must be bulletproof.
2. **Non-domain board emails (Dustin).** DWD silently fails or, worse, a future bug lets
   it fall back to a wrong identity. Mitigation: explicit `impersonation_unavailable`
   4xx; never SA-direct fallback for an impersonation-typed source; unit test the
   non-domain path.
3. **Stale `owner_email` after a member offboards / changes domain.** A disabled member's
   folders keep getting impersonated. Mitigation: watcher already writes `last_error` and
   holds cursor on Google auth failure; add a board-visible "errored sources" surface
   (status column already exists: `last_error`). Out of scope to auto-disable now.

### Over/under-built check
- **Don't build**: an OAuth picker (Google Picker JS / per-user OAuth tokens). DWD reuse
  is the 10x move — no new consent screen, no token storage, no refresh plumbing. The
  picker is a plain server-rendered tree from our two listing endpoints.
- **Don't build**: admin "register on behalf of" override now (separate gate + audit).
- **Under-built risk**: the org-membership check (§4.3) — without it a member can
  mis-attribute. Cheap to add; include it.

### Decomposition (Linear issues)
- **B1 (backend, mig)**: migration 157 `owner_email` + the orthogonality comment. Tiny.
- **B2 (backend)**: `resolveImpersonationEmail` helper (api.js, beside
  `requireBoardAdmin`) + GET `/api/drive/shared-drives` + GET `/api/drive/folders`
  endpoints with the central Google-error→4xx mapper. Classify both routes in
  `route-tiers.js` (board-human tier) — REQUIRED (new HTTP routes).
- **B3 (backend)**: extend `POST /api/capture-sources` to stamp `owner_email` from the
  resolver + add the org-membership constraint; regression test: body `owner_email`
  ignored, non-domain email → 4xx, duplicate folder → 409.
- **U1 (board UI)**: folder/Shared-Drive picker (lazy-expand tree off the two endpoints)
  + assign org/default_kind/allowlist → POST.
- **U2 (board UI)**: management page — list sources with status (last_poll_at, last_error,
  enabled toggle via existing PATCH, # captured via artifacts count).

**Watcher: no change** (already impersonation-ready). **board-user→email mapping: EXISTS**
(`board_members.email`) — no new mapping table needed; the only gap is non-domain emails,
handled by failing closed.
