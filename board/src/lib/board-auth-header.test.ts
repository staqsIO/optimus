/**
 * OPT-148 / ADR-019 — the board proxies carry identity as a verified board JWT,
 * never the shared OPS_API_SECRET + a spoofable `x-board-user` header.
 *
 * These tests pin the security-relevant contract of the header minter:
 *   - no resolvable username → null (deny by default; callers 401);
 *   - identity travels as a signature-verifiable board JWT whose claims match
 *     the verified session (github_username = username; sub = boardMemberId
 *     when known, else username);
 *   - `x-board-user` is present only as an audit echo of the verified username.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { verifyBoardToken, _resetKeysForTest } from "./board-jwt";
import { boardAuthHeadersFromIdentity } from "./board-auth-header";

beforeEach(() => {
  delete process.env.BOARD_JWT_KEY_PEM;
  _resetKeysForTest();
});

describe("board-auth-header (OPT-148 / ADR-019)", () => {
  it("returns null when no username is resolvable (deny by default)", () => {
    expect(boardAuthHeadersFromIdentity({})).toBeNull();
    expect(boardAuthHeadersFromIdentity({ username: null })).toBeNull();
    expect(boardAuthHeadersFromIdentity({ username: "" })).toBeNull();
  });

  it("mints a verifiable board JWT (not an opaque shared secret) carrying the verified identity", async () => {
    const headers = boardAuthHeadersFromIdentity({
      username: "ecgang",
      boardMemberId: "11111111-1111-1111-1111-111111111111",
    });
    expect(headers).not.toBeNull();

    // Identity is a signed board JWT, not a static secret.
    expect(headers!.Authorization).toMatch(/^Bearer /);
    const token = headers!.Authorization.slice("Bearer ".length);
    expect(token.split(".")).toHaveLength(3);

    const claims = await verifyBoardToken(token);
    expect(claims.github_username).toBe("ecgang");
    expect(claims.sub).toBe("11111111-1111-1111-1111-111111111111");

    // x-board-user is audit-only and must echo the verified username.
    expect(headers!["x-board-user"]).toBe("ecgang");
  });

  it("falls back sub to the username when boardMemberId is absent", async () => {
    const headers = boardAuthHeadersFromIdentity({ username: "dustin" });
    expect(headers).not.toBeNull();
    const token = headers!.Authorization.slice("Bearer ".length);
    const claims = await verifyBoardToken(token);
    expect(claims.sub).toBe("dustin");
    expect(claims.github_username).toBe("dustin");
  });
});
