/**
 * Tests for the default-deny board auth wrapper.
 *
 * Covers the task-required claims:
 *   - Route without a JWT / session returns 401.
 *   - Route with an expired/invalid JWT returns 401.
 *   - Route with user-A's JWT exposes A's identity (NOT B's).
 *   - Allowlisted routes remain reachable without a JWT.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  isPublicRoute,
  resolveBoardIdentity,
  requireBoardAuth,
  PUBLIC_ROUTES,
} from "./require-board-auth";
import { issueBoardToken, _resetKeysForTest } from "./board-jwt";

// next-auth/jwt's getToken reads a cookie — for unit tests we mock it.
vi.mock("next-auth/jwt", () => ({
  getToken: vi.fn(),
}));

import { getToken } from "next-auth/jwt";
const mockedGetToken = getToken as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  delete process.env.BOARD_JWT_KEY_PEM;
  _resetKeysForTest();
  mockedGetToken.mockReset();
});

function mkReq(opts: {
  method?: string;
  url?: string;
  authorization?: string;
}): NextRequest {
  const headers = new Headers();
  if (opts.authorization) headers.set("authorization", opts.authorization);
  return new NextRequest(opts.url || "http://localhost/api/test", {
    method: opts.method || "GET",
    headers,
  });
}

describe("isPublicRoute", () => {
  it("treats /api/auth/** (NextAuth) as public except /api/auth/board-token", () => {
    expect(
      isPublicRoute(mkReq({ method: "GET" }), "/api/auth/signin")
    ).toBe(true);
    expect(
      isPublicRoute(mkReq({ method: "GET" }), "/api/auth/callback/github")
    ).toBe(true);
    expect(
      isPublicRoute(mkReq({ method: "POST" }), "/api/auth/board-token")
    ).toBe(false);
  });

  it("treats /api/health GET as public", () => {
    expect(isPublicRoute(mkReq({ method: "GET" }), "/api/health")).toBe(true);
  });

  it("denies routes not in the allowlist", () => {
    expect(
      isPublicRoute(mkReq({ method: "GET" }), "/api/governance")
    ).toBe(false);
    expect(
      isPublicRoute(mkReq({ method: "POST" }), "/api/workstation/ask")
    ).toBe(false);
  });

  it("PUBLIC_ROUTES set is non-empty and contains health check", () => {
    expect(PUBLIC_ROUTES.has("GET /api/health")).toBe(true);
  });
});

describe("resolveBoardIdentity", () => {
  it("returns null when there is no session and no Bearer header", async () => {
    mockedGetToken.mockResolvedValue(null);
    const id = await resolveBoardIdentity(mkReq({}));
    expect(id).toBeNull();
  });

  it("derives identity from a NextAuth session token", async () => {
    mockedGetToken.mockResolvedValue({
      username: "alice",
      boardMemberId: "alice-uuid",
    });
    const id = await resolveBoardIdentity(mkReq({}));
    expect(id).toEqual({
      username: "alice",
      sub: "alice-uuid",
      source: "nextauth",
      scope: ["*"],
    });
  });

  it("verifies a Bearer board JWT when no NextAuth session is present", async () => {
    mockedGetToken.mockResolvedValue(null);
    const { token } = issueBoardToken("alice-uuid", "alice");
    const id = await resolveBoardIdentity(
      mkReq({ authorization: `Bearer ${token}` })
    );
    expect(id?.username).toBe("alice");
    expect(id?.sub).toBe("alice-uuid");
    expect(id?.source).toBe("jwt");
  });

  it("rejects an invalid Bearer token (returns null)", async () => {
    mockedGetToken.mockResolvedValue(null);
    const id = await resolveBoardIdentity(
      mkReq({ authorization: "Bearer not.a.real.jwt" })
    );
    expect(id).toBeNull();
  });

  it("does NOT confuse user-A's JWT with user-B's identity", async () => {
    mockedGetToken.mockResolvedValue(null);
    const { token: tokenA } = issueBoardToken("alice-uuid", "alice");
    const { token: tokenB } = issueBoardToken("bob-uuid", "bob");

    const idA = await resolveBoardIdentity(
      mkReq({ authorization: `Bearer ${tokenA}` })
    );
    const idB = await resolveBoardIdentity(
      mkReq({ authorization: `Bearer ${tokenB}` })
    );

    expect(idA?.username).toBe("alice");
    expect(idB?.username).toBe("bob");
    expect(idA?.sub).not.toBe(idB?.sub);
  });
});

describe("requireBoardAuth wrapper", () => {
  it("returns 401 on a non-public route when caller is unauthenticated", async () => {
    mockedGetToken.mockResolvedValue(null);
    const handler = requireBoardAuth("/api/governance", async () => {
      return new Response("ok");
    });
    const res = await handler(mkReq({ method: "GET" }), undefined);
    expect(res.status).toBe(401);
  });

  it("invokes handler with derived identity when caller is authenticated", async () => {
    mockedGetToken.mockResolvedValue({
      username: "ecgang",
      boardMemberId: "ec-uuid",
    });
    const handler = requireBoardAuth(
      "/api/governance",
      async (_req, identity) => {
        return Response.json({ caller: identity.username, sub: identity.sub });
      }
    );
    const res = await handler(mkReq({ method: "GET" }), undefined);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.caller).toBe("ecgang");
    expect(body.sub).toBe("ec-uuid");
  });

  it("invokes handler for a public route without checking auth", async () => {
    mockedGetToken.mockResolvedValue(null);
    const handler = requireBoardAuth("/api/health", async () => {
      return Response.json({ status: "ok" });
    });
    const res = await handler(mkReq({ method: "GET" }), undefined);
    expect(res.status).toBe(200);
  });
});
