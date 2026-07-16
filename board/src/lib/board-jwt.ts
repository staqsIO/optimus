/**
 * Board member JWT issuer and verifier for the Next.js board app.
 *
 * MUST stay in lockstep with `lib/runtime/board-jwt.js` (the autobot-inbox
 * verifier). Both processes share the same RS256 keypair via
 * `BOARD_JWT_KEY_PEM`. Claims shape and `iss` value MUST match exactly —
 * any drift breaks cross-process verification.
 *
 * P1 (deny-by-default): no token = no access.
 * P2 (infra-not-prompts): signature is verified by RS256, not by trusting
 * any header the caller sets.
 * P4 (boring infra): Node `crypto` only — no external JWT library.
 *
 * Key management:
 *   1. BOARD_JWT_KEY_PEM env var → inline PEM (Railway/Docker — production)
 *   2. Ephemeral RSA pair (dev/CI when env var unset). Ephemeral keys will
 *      NOT verify across processes — only valid for local dev/single-process.
 */

import {
  createSign,
  createVerify,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  type KeyObject,
} from "crypto";

// 15 minutes — short enough that revocation isn't critical for the Next.js
// side, long enough to avoid re-minting on every request. autobot-inbox's
// verifier additionally consults a `token_revocations` table for instant
// kill, so server-side revocation works regardless of TTL.
const TOKEN_TTL_SECONDS = 15 * 60;
const ISSUER = "optimus-board";

interface BoardTokenClaims {
  iss: string;
  sub: string; // memberId (UUID) OR github username when no memberId is known
  github_username: string;
  scope: string[];
  iat: number;
  exp: number;
  jti: string;
}

interface IssuedToken {
  token: string;
  expiresAt: number; // ms epoch — Date-compatible
  jti: string;
}

interface KeyState {
  privateKey: string | KeyObject | null;
  publicKey: string | KeyObject | null;
  source: "env-pem" | "ephemeral" | null;
}

const keyState: KeyState = {
  privateKey: null,
  publicKey: null,
  source: null,
};

function base64url(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64urlDecode(str: string): Buffer {
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/**
 * Lazy key initialization — runs on first sign/verify in this process.
 * Idempotent; safe to call repeatedly.
 */
function ensureKeys(): void {
  if (keyState.privateKey && keyState.publicKey) return;

  const pemEnv = process.env.BOARD_JWT_KEY_PEM;
  if (pemEnv) {
    // Railway env vars often arrive with literal "\n" sequences instead of
    // real newlines — normalize before passing to crypto.
    const pem = pemEnv.replace(/\\n/g, "\n");
    keyState.privateKey = pem;
    keyState.publicKey = createPublicKey(pem).export({
      type: "spki",
      format: "pem",
    }) as string;
    keyState.source = "env-pem";
    return;
  }

  // Ephemeral fallback for dev/CI — tokens minted here can only be verified
  // inside this same process. Production deploys MUST set BOARD_JWT_KEY_PEM.
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  keyState.privateKey = pair.privateKey;
  keyState.publicKey = pair.publicKey;
  keyState.source = "ephemeral";
}

/**
 * Issue a board JWT.
 *
 * @param sub - Subject identifier. UUID from `board_members.id` when known,
 *              else the GitHub username (autobot-inbox tolerates both).
 * @param githubUsername - Always set; used by autobot-inbox to attribute
 *                         actions to a board member via `acted_by`.
 * @param scope - Default `['*']` (full board scope). Reserved for future
 *                fine-grained capability scoping.
 */
export function issueBoardToken(
  sub: string,
  githubUsername: string,
  scope: string[] = ["*"]
): IssuedToken {
  if (!sub) throw new Error("issueBoardToken: sub is required");
  if (!githubUsername) {
    throw new Error("issueBoardToken: githubUsername is required");
  }
  ensureKeys();

  const now = Math.floor(Date.now() / 1000);
  const exp = now + TOKEN_TTL_SECONDS;
  const jti = randomUUID();

  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iss: ISSUER,
      sub,
      github_username: githubUsername,
      scope,
      iat: now,
      exp,
      jti,
    } satisfies BoardTokenClaims)
  );

  const signable = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signable);
  const signature = base64url(signer.sign(keyState.privateKey!));

  return {
    token: `${signable}.${signature}`,
    expiresAt: exp * 1000,
    jti,
  };
}

/**
 * Verify a board JWT and return its claims.
 *
 * Verification order: structural → signature → issuer → expiry.
 *
 * NOTE: revocation list check is NOT performed here — that requires DB
 * access. The Next.js board only verifies its own tokens for the mint
 * endpoint round-trip and for testing. autobot-inbox is the canonical
 * verifier (with revocation) for protected routes.
 */
export function verifyBoardToken(token: string): BoardTokenClaims {
  if (!token || typeof token !== "string") {
    throw new Error("verifyBoardToken: token must be a non-empty string");
  }
  ensureKeys();

  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed JWT: expected 3 parts");
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  const signable = `${headerB64}.${payloadB64}`;
  const signature = base64urlDecode(signatureB64);
  const verifier = createVerify("RSA-SHA256");
  verifier.update(signable);
  if (!verifier.verify(keyState.publicKey!, signature)) {
    throw new Error("Board JWT signature verification failed");
  }

  // Header validation — pin alg to RS256 to defeat the "alg: none" downgrade
  let headerJson: unknown;
  try {
    headerJson = JSON.parse(base64urlDecode(headerB64).toString("utf-8"));
  } catch {
    throw new Error("Malformed JWT header");
  }
  const header = headerJson as { alg?: unknown; typ?: unknown };
  if (header.alg !== "RS256") {
    throw new Error(`Unsupported JWT alg: ${String(header.alg)}`);
  }

  let claims: BoardTokenClaims;
  try {
    claims = JSON.parse(
      base64urlDecode(payloadB64).toString("utf-8")
    ) as BoardTokenClaims;
  } catch {
    throw new Error("Malformed JWT payload");
  }

  if (claims.iss !== ISSUER) {
    throw new Error(`Invalid JWT issuer: ${claims.iss} (expected ${ISSUER})`);
  }

  const now = Math.floor(Date.now() / 1000);
  if (claims.exp <= now) {
    throw new Error(
      `Board JWT expired at ${new Date(claims.exp * 1000).toISOString()}`
    );
  }

  return claims;
}

/**
 * Test-only: reset key state so a test can flip env vars and re-initialize.
 * Production code must NOT call this.
 *
 * @internal
 */
export function _resetKeysForTest(): void {
  keyState.privateKey = null;
  keyState.publicKey = null;
  keyState.source = null;
}

/**
 * Test-only: peek at the key source for assertions.
 *
 * @internal
 */
export function _getKeySourceForTest(): KeyState["source"] {
  return keyState.source;
}

export const __INTERNAL_TTL_SECONDS = TOKEN_TTL_SECONDS;
export const __INTERNAL_ISSUER = ISSUER;
