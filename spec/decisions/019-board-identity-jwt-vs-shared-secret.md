# ADR-019: Board identity via short-lived JWT; `INBOX_API_SECRET` becomes ops-only

- **Status:** Proposed (OPT-148, security)
- **Date:** 2026-06-13
- **Deciders:** Eric, Dustin (board)
- **Supersedes operationally:** the reverted PR #238 / hotfix #248 / shim #250 line
- **Principles:** P1 (deny-by-default), P2 (infra enforces, prompts/headers advise), P3 (transparency), P4 (boring infra)

---

## Context — the vulnerability

`INBOX_API_SECRET` is double-duty:

1. **Board-human transport.** The three board proxies (`board/src/app/api/ops/route.ts`,
   `board/src/app/api/inbox-proxy/route.ts`, `board/src/lib/ops-proxy.ts`) verify the
   human via NextAuth/GitHub, then call the backend with
   `Authorization: Bearer ${API_SECRET}` + `x-board-user: <verified username>`.
2. **Ops/agent secret.** Scripts/agents and the `source==='api_secret'` path in
   `autobot-inbox/src/api-routes/document-access.js` use the same secret.

Backend `resolveAuth` (`autobot-inbox/src/api.js:286-296`) turns an opaque-Bearer caller into
`{ role:'board', source:'api_secret', github_username: req.headers['x-board-user'] || null }`.
**It promotes a client-supplied header into board-member identity.** Any holder of the shared
secret (every script, every agent host, anything that has ever read the env var) can send
`x-board-user: <any board member>` and:

- pass all ~8 `role:'board' && github_username` write gates (document-access, artifacts,
  federation, capture-sources, meeting-registry, customer-auth, slack-project-map), and
- reach `resolveImpersonationEmail` (`api.js:389`) → **impersonate that member's Google Drive
  via domain-wide delegation.**

The naive fix (null the header-derived `github_username`) breaks the live board, because the
board has only ever used the header.

## Decisive finding — the fix is already built, just unwired

The per-user JWT path **exists on both sides and is dormant**, not missing:

| Piece | File | State |
|---|---|---|
| Board-side signer + verifier | `board/src/lib/board-jwt.ts` | Present. RS256, `iss:'optimus-board'`, 15-min TTL, alg-pinned. |
| Mint endpoint | `board/src/app/api/auth/board-token/route.ts` | Present. Mints from the verified NextAuth session (`sub`, `github_username` from token, never body). **Dead — no caller.** |
| Board route guard | `board/src/lib/require-board-auth.ts` | Present. NextAuth-or-JWT, identity from verified credential. |
| Backend verifier | `lib/runtime/agents/board-jwt.js` (imported as `./runtime/board-jwt.js`) | Present. Signature + issuer + expiry + `token_revocations` jti check (instant kill). |
| Backend `resolveAuth` JWT branch | `autobot-inbox/src/api.js:228-244` | Present. Mints `{ role:'board', source:'jwt', github_username: claims.github_username }`. |
| Shared key | `BOARD_JWT_KEY_PEM` env | Same keypair both processes; board signs, backend verifies. |

What's missing is one wire: **the three proxies still send `Bearer ${API_SECRET}` + spoofable
header instead of minting and forwarding a board JWT.** PR #238 wired exactly this, was
hotfix-reverted for an unrelated build break (#248), and stubbed back to the legacy path (#250 —
`getOpsAuthHeaders`/`getOpsAuth`/`proxyOpsAdmin` shims in `ops-proxy.ts`). The shims even carry a
TODO pointing at STAQPRO-528 to "re-introduce per-user JWT properly."

## Decision

**Adopt Option 1 (proxy mints a short-lived board JWT). `api_secret` loses board identity and
becomes ops-only.** This is the right call *and* the cheap call, because the leverage is already
on disk — OPT-148 is a wiring + cutover task, not a build.

### Why Option 1 beats the alternatives

- **vs Option 2 (trusted-proxy HMAC / second secret):** A second shared secret moves the trust
  boundary but keeps the same broken model — identity still rides in a header the *infrastructure
  trusts because of a secret*, violating P2 (infra must enforce identity, not advise it). It also
  gives zero per-user revocation, no expiry, no audit-grade `jti`, and adds a *new* long-lived
  secret to rotate. It would be net-new code to get a strictly weaker result than code we already
  have. Reject.
- **vs do-nothing / scope the header:** can't — breaks the board.
- **Contrarian-leverage read:** the highest-leverage move is not designing a new mechanism; it's
  recognizing the mechanism exists and the only defect is that the proxy never switched to it.
  Build cost ≈ 0; the work is a safe dual-accept cutover and a backend hardening flip.

### (b) Key distribution — board app **signs**, no backend mint endpoint

The board app signs locally with the private half of `BOARD_JWT_KEY_PEM` (already its design).
The backend holds the same PEM only to **verify**.

- **Chosen: board signs (symmetric possession of the RSA private key via shared `BOARD_JWT_KEY_PEM`).**
  Tradeoff: the board process holds the signing key, so a board-app RCE could mint arbitrary board
  identities. Accepted because (1) the board is already the NextAuth trust root — if it's
  compromised, the attacker already has session-level board access; (2) it's zero new network
  surface; (3) it's what's deployed.
- **Rejected: backend exposes a mint endpoint the proxy calls.** Tradeoff: keeps the private key
  off the board host (smaller blast radius if the board is breached) but adds a network round-trip
  per token, a *new* privileged endpoint that itself needs caller authentication (chicken-and-egg:
  what authenticates the proxy to the mint endpoint? — back to a shared secret), and more moving
  parts. Not worth it for two first-party processes that already share an env-injected key.
- **Key hardening to add now:** asymmetric keys mean the backend only needs the **public** half.
  Split `BOARD_JWT_KEY_PEM` (private, board only) from `BOARD_JWT_PUBLIC_PEM` (backend only) so the
  backend host cannot mint. The current code derives the public key from the private PEM on both
  sides; switching the backend to a public-only PEM is a small, strictly-safer change and should
  ride this ADR. **Recovery from the symmetric-key tradeoff above.**

### (c) `api_secret` becomes cleanly ops-only

- In `resolveAuth` (`api.js:286-296`), the `api_secret` branch sets
  **`github_username: null`** unconditionally and drops the `x-board-user` read. Result:
  `{ sub:'legacy', role:'board', source:'api_secret', github_username:null, scope:['*'] }`.
- `document-access.js` already treats `source==='api_secret'` as operational tooling that resolves
  to `syntheticPrincipal(STAQS)` and **requires an explicit `ownerId`/`orgScope` rather than
  deriving identity** (lines 32, 53, 111-129, 199-201). Nulling `github_username` does **not**
  break it — that path never consumed the username. Verify the other ~8 board-write gates: each
  must continue to work for `source==='jwt'` (real board users via the proxy) and must **no longer**
  be reachable by `api_secret` (they'll fail the `&& github_username` check, which is the goal).
  Any *legitimate* ops script that needs a board-write gate must be moved onto an agent JWT or given
  an explicit ops carve-out — enumerate these during implementation (expected: few/none, since
  scripts mostly do reads + explicit-owner writes).
- `resolveImpersonationEmail` already requires `role==='board' && github_username` (`api.js:387`).
  Once `api_secret` carries `github_username:null`, **DWD impersonation is unreachable by secret
  holders** with no extra code. Optionally also assert `req.auth.source==='jwt'` there as
  belt-and-suspenders.

### (d) Migration sequence that never breaks the live board

Dual-accept, then tighten. Each step is independently deployable and reversible.

1. **Backend (no behavior change):** confirm the `source:'jwt'` branch is live and
   `BOARD_JWT_KEY_PEM` verifies board-minted tokens in prod. Add a counter/log tag distinguishing
   `source:'jwt'` vs `source:'api_secret'` board calls (P3) so we can watch the cutover.
2. **Board (additive):** in all three proxies, mint a board JWT per request from the NextAuth
   session (reuse `issueBoardToken` from `board/src/lib/board-jwt.ts`; the `/api/auth/board-token`
   endpoint can be called or the helper used in-process) and send
   `Authorization: Bearer <jwt>`. **Stop sending `x-board-user`.** Keep `INBOX_API_SECRET` available
   as fallback behind a flag (`BOARD_AUTH_MODE=jwt|legacy`) for one deploy. Un-stub the
   `ops-proxy.ts` shims to the real JWT path (this *is* STAQPRO-528's intent).
3. **Observe:** confirm `source:'api_secret'` board-attributed traffic from the board origin drops
   to zero; only scripts/agents remain on the secret. Watch for 401s.
4. **Backend (tighten — the actual fix):** flip the `api_secret` branch to `github_username:null`
   (step c). Board is unaffected because it's now on JWT. Optionally pin
   `resolveImpersonationEmail` to `source:'jwt'`.
5. **Cleanup:** remove the `BOARD_AUTH_MODE` legacy fallback and the `x-board-user` plumbing from
   the proxies; remove the dead-then-revived confusion in `ops-proxy.ts`. Rotate `INBOX_API_SECRET`
   (it's now lower-privilege; rotation invalidates any leaked copy that was relying on identity
   forgery).
6. **Split keys (step b hardening):** give the backend a public-only PEM; keep private on the board.

Rollback at any step = revert that deploy; the dual-accept window means step 2 and step 4 are never
live-broken simultaneously.

### (e) Risks & what could go wrong

- **`BOARD_JWT_KEY_PEM` mismatch across processes** → all board calls 401. Mitigate: step-1
  verification in prod before step 2; keep legacy fallback flag through step 3.
- **15-min TTL expiry mid-session** → mint per request (cheap, RS256 sign is sub-ms) or on 401
  retry; do not cache a token across its TTL on the client.
- **A real ops script depended on board-write identity** → it 401s at step 4. Mitigate: step-3
  observation enumerates exactly who's still on `api_secret` before the flip; move them to agent JWT
  or an explicit ops carve-out *before* step 4.
- **Board-app compromise mints board tokens** (the Option-1 key tradeoff) → bounded by step-b
  public/private split and by `token_revocations` instant-kill; and a board-app RCE already implies
  board-session access regardless.
- **Clock skew** between board and backend → small `exp` grace already implicit in 15-min TTL;
  acceptable.

### (f) ADR warranted?

**Yes — this is exactly an ADR.** It changes a security boundary and identity model, reverses the
operational meaning of a shared secret, and resurrects a previously-reverted approach (#238); the
"why Option 1 over a second-secret HMAC" and "board-signs over backend-mint" tradeoffs need to be
on record so the #238→revert→re-adopt loop isn't re-litigated. This file is that record.

## Consequences

- Identity becomes infrastructure-enforced (RS256 signature), not header-advised (P2 satisfied).
- Per-user audit (`jti`), expiry, and instant revocation for board actions.
- `INBOX_API_SECRET` demoted to ops-only, lower blast radius, safely rotatable.
- DWD Drive impersonation can no longer be forged by a secret holder.
- Net new code is small (proxy mint wiring + one backend null + optional key split); the rest is
  un-stubbing #250 and a staged cutover.
