# OAuth Recovery (Gmail `invalid_grant`)

When a Gmail account in `inbox.accounts` lands in `sync_status='error'` with
`last_error='invalid_grant'` (or similar — `unauthorized_client`,
`invalid_client`, `token has been expired or revoked`), the refresh token is
dead and no amount of polling will recover. The user has to re-authorize.

## Symptom

- `/api/status` reports the account as connected but errors.
- `/settings` shows the row in red with status `error`.
- Production logs: `[auto-archive] sweep failed: invalid_grant`,
  `[gmail-poller] auth failure for <email>`, etc.
- Resyncing the account is a no-op — it resets internal sync state but never
  starts a new OAuth dance.

## Recovery (post-STAQPRO-318)

On `/settings`, an auth-failure row shows a **Reconnect** button instead of
Sync Contacts / Resync. The flow:

1. User clicks Reconnect on the failed row.
2. Board calls `GET /api/auth/gmail-url?accountId=<id>&owner=<github_user>`.
3. Backend looks up the row, encodes `accountId` + `expectEmail` into the
   OAuth state, adds `login_hint=<existing-email>` to the consent URL, and
   returns it.
4. Browser redirects to Google. The pre-filled hint surfaces the same Google
   account; user grants consent.
5. Google redirects back to `/api/auth/gmail-callback`. Backend parses state,
   verifies the newly-authed email **matches** `expectEmail` (refuses
   otherwise to prevent stranger-account injection), and UPDATEs the existing
   row with fresh credentials, `sync_status='active'`, `last_error=NULL`.
6. Redirect back to `/settings?reconnected=true`.

**No new account row is created.** The voice profile, sync history, and
training state on the existing row are preserved.

## What changed in code

- `autobot-inbox/src/api.js` — `GET /api/auth/gmail-url` accepts
  `accountId`; `GET /api/auth/gmail-callback` reads `state.reconnect` /
  `state.accountId` / `state.expectEmail` and takes the rebind path.
- `board/src/app/settings/page.tsx` — `reconnectAccount(accountId)` handler,
  `isAuthFailure(last_error)` predicate, and a conditional Reconnect button
  in the actions block that replaces Sync Contacts / Resync when the row is
  in auth-error state.

## What still requires "Disconnect → Add Gmail Account"

- The user wants to change the email tied to a row (different Google
  account). Reconnect refuses cross-account rebinding by design.
- The row itself is corrupted at a level credentials can't fix
  (e.g., `owner_id` foreign key broken).
- The OAuth client_id / client_secret in env was rotated and the row's
  `credentials` blob still references the old client. (Future fix:
  re-encrypt on reconnect always.)

## Diagnostic checklist when Reconnect fails

| Symptom | Likely cause |
|---|---|
| Browser lands on `Reconnect Mismatch` page | User signed into the wrong Google account in the browser. Sign out and retry. |
| Reconnect succeeds but next poll still errors | Token was successfully rebound but the worker is using a stale cached client. Restart the Railway service. |
| `Account not found` from `gmail-url` | The row was deleted between gmail-url request and the click. Refresh `/settings`. |
| `gmail-url` returns the GMAIL_CLIENT_ID error | Env vars missing — not a reconnect-specific issue. |

## Related

- STAQPRO-306 — voice-retrain silent OAuth failure (same class, different
  surface).
- STAQPRO-318 — this ticket.
