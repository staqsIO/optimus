/**
 * Tests for board JWT issuer + verifier (Worktree 2 — tenancy hardening).
 *
 * Covers the security-relevant claims from the task:
 *   - Sign/verify roundtrip succeeds for a valid token.
 *   - Tampered signatures are rejected.
 *   - Expired tokens are rejected.
 *   - Wrong-issuer tokens are rejected (defends against agent-JWT confusion).
 *   - `alg: none` downgrade is rejected.
 *   - Verifier never returns claims for a token it didn't sign.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createSign, generateKeyPairSync } from "crypto";
import {
  issueBoardToken,
  verifyBoardToken,
  _resetKeysForTest,
  _getKeySourceForTest,
  __INTERNAL_ISSUER,
} from "./board-jwt";

function base64url(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

beforeEach(() => {
  delete process.env.BOARD_JWT_KEY_PEM;
  _resetKeysForTest();
});

describe("board-jwt", () => {
  it("issues a token whose claims roundtrip through verifyBoardToken", () => {
    const { token, expiresAt, jti } = issueBoardToken(
      "member-123",
      "ecgang",
      ["*"]
    );

    expect(token.split(".")).toHaveLength(3);
    expect(jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(expiresAt).toBeGreaterThan(Date.now());

    const claims = verifyBoardToken(token);
    expect(claims.iss).toBe(__INTERNAL_ISSUER);
    expect(claims.sub).toBe("member-123");
    expect(claims.github_username).toBe("ecgang");
    expect(claims.scope).toEqual(["*"]);
    expect(claims.jti).toBe(jti);
  });

  it("uses an ephemeral key when BOARD_JWT_KEY_PEM is unset", () => {
    issueBoardToken("m", "u");
    expect(_getKeySourceForTest()).toBe("ephemeral");
  });

  it("rejects a token with a tampered payload", () => {
    const { token } = issueBoardToken("member-123", "ecgang");
    const [h, p, s] = token.split(".");
    // Re-encode the payload with a different sub but keep the original sig.
    const tamperedPayload = base64url(
      JSON.stringify({
        iss: __INTERNAL_ISSUER,
        sub: "attacker",
        github_username: "attacker",
        scope: ["*"],
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 60,
        jti: "00000000-0000-0000-0000-000000000000",
      })
    );
    void p;
    const tampered = `${h}.${tamperedPayload}.${s}`;
    expect(() => verifyBoardToken(tampered)).toThrow(/signature verification/);
  });

  it("rejects an expired token", () => {
    // Manually craft a token with exp in the past using the *current* private
    // key via internal trickery: issue a real token, then replace its payload
    // with an expired one signed with the same key.
    // Simpler: stash issued token, manipulate the payload, then re-sign with
    // a fresh keypair to prove that even validly-signed-but-expired tokens
    // are rejected — but the simpler path is to issue a token with a
    // negative-TTL crafted payload using our internal signer.
    const pair = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    process.env.BOARD_JWT_KEY_PEM = pair.privateKey as string;
    _resetKeysForTest();

    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const past = Math.floor(Date.now() / 1000) - 3600;
    const payload = base64url(
      JSON.stringify({
        iss: __INTERNAL_ISSUER,
        sub: "member-x",
        github_username: "ecgang",
        scope: ["*"],
        iat: past - 60,
        exp: past,
        jti: "test-expired",
      })
    );
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${payload}`);
    const sig = base64url(signer.sign(pair.privateKey));
    const expiredToken = `${header}.${payload}.${sig}`;

    expect(() => verifyBoardToken(expiredToken)).toThrow(/expired/);
  });

  it("rejects an `alg: none` token", () => {
    // Issue a valid token, then swap header to alg: none and drop signature.
    const { token } = issueBoardToken("m", "u");
    const [, payload] = token.split(".");
    const noneHeader = base64url(JSON.stringify({ alg: "none", typ: "JWT" }));
    const noneToken = `${noneHeader}.${payload}.`;
    // Signature is empty/garbage — verifier MUST fail on signature first
    // (the alg pin defends in depth if a future bug skips that).
    expect(() => verifyBoardToken(noneToken)).toThrow();
  });

  it("rejects a token with the wrong issuer (e.g. agent-JWT spoofing)", () => {
    // Use the same keypair to sign a token with iss: 'optimus-agent' and
    // verify it is rejected — defends against cross-issuer token confusion
    // when key material is shared by mistake.
    const pair = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    process.env.BOARD_JWT_KEY_PEM = pair.privateKey as string;
    _resetKeysForTest();

    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = base64url(
      JSON.stringify({
        iss: "optimus-agent",
        sub: "member-x",
        github_username: "ecgang",
        scope: ["*"],
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 60,
        jti: "test-wrong-iss",
      })
    );
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${payload}`);
    const sig = base64url(signer.sign(pair.privateKey));
    const wrongIss = `${header}.${payload}.${sig}`;

    expect(() => verifyBoardToken(wrongIss)).toThrow(/Invalid JWT issuer/);
  });

  it("rejects malformed input shapes early", () => {
    expect(() => verifyBoardToken("")).toThrow();
    expect(() => verifyBoardToken("not.a.jwt.too.many.parts")).toThrow();
    expect(() => verifyBoardToken("only-one-part")).toThrow();
  });

  it("requires sub and githubUsername at mint time", () => {
    expect(() => issueBoardToken("", "ecgang")).toThrow();
    expect(() => issueBoardToken("m", "")).toThrow();
  });
});
