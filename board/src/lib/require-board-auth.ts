/**
 * Default-deny auth wrapper for board API routes (P1).
 *
 * Two accepted credentials, in order:
 *   1. NextAuth session (set by the GitHub OAuth flow) — primary path for
 *      browser callers.
 *   2. `Authorization: Bearer <board-jwt>` header — used by server-to-server
 *      callers within the board (e.g., a route that issues a JWT then calls
 *      its own helper).
 *
 * Identity is derived from the verified credential — NEVER from
 * body/query-string userId. Route handlers receive `{ username, sub }` and
 * MUST scope any data access by those fields.
 *
 * Routes that are intentionally public MUST be enumerated in PUBLIC_ROUTES.
 * Adding a public route is a security review event — that's the point.
 */

import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { verifyBoardToken } from "@/lib/board-jwt";

export interface BoardIdentity {
  /** GitHub username — primary actor identifier for audit. */
  username: string;
  /** Token `sub` claim — board_members.id when known, else github username. */
  sub: string;
  /** Where the identity came from. */
  source: "nextauth" | "jwt";
  /** Board JWT scopes (`['*']` for NextAuth-derived identities). */
  scope: string[];
}

/**
 * Endpoints that don't need a board identity. Format: `<METHOD> <path>`.
 *
 * Path matching is exact (no globbing). Adding an entry here makes that
 * endpoint reachable from the public internet — review the consequences.
 */
export const PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  // NextAuth's own callbacks must be reachable before a session exists.
  "GET /api/auth/signin",
  "POST /api/auth/signin",
  "GET /api/auth/signout",
  "POST /api/auth/signout",
  "GET /api/auth/callback",
  "POST /api/auth/callback",
  "GET /api/auth/csrf",
  "GET /api/auth/providers",
  "GET /api/auth/session",
  "GET /api/auth/error",
  // Health check for Railway / load balancers.
  "GET /api/health",
]);

function routeKey(req: NextRequest, routePath: string): string {
  return `${req.method.toUpperCase()} ${routePath}`;
}

/**
 * Check if a route is in the public allowlist.
 *
 * Pass the *declared* route path (not `req.url`), so dynamic segments are
 * matched by template rather than by concrete value.
 */
export function isPublicRoute(req: NextRequest, routePath: string): boolean {
  // NextAuth's `[...nextauth]` catch-all is anything under `/api/auth/...`
  // except the routes WE add (currently only `/api/auth/board-token`).
  if (
    routePath.startsWith("/api/auth/") &&
    routePath !== "/api/auth/board-token"
  ) {
    return true;
  }
  return PUBLIC_ROUTES.has(routeKey(req, routePath));
}

/**
 * Resolve the calling identity. Returns null when no valid credential is
 * presented — callers should respond 401.
 */
export async function resolveBoardIdentity(
  req: NextRequest
): Promise<BoardIdentity | null> {
  // 1. NextAuth session (cookie-based — set by GitHub OAuth flow).
  const sessionToken = await getToken({ req });
  const sessionUsername =
    typeof sessionToken?.username === "string" ? sessionToken.username : null;
  if (sessionUsername) {
    const boardMemberId =
      typeof sessionToken?.boardMemberId === "string"
        ? sessionToken.boardMemberId
        : sessionUsername;
    return {
      username: sessionUsername,
      sub: boardMemberId,
      source: "nextauth",
      scope: ["*"],
    };
  }

  // 2. Authorization: Bearer <board-jwt> — for server-to-server callers.
  const authHeader = req.headers.get("authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    try {
      const claims = verifyBoardToken(token);
      return {
        username: claims.github_username,
        sub: claims.sub,
        source: "jwt",
        scope: Array.isArray(claims.scope) ? claims.scope : ["*"],
      };
    } catch {
      // Fall through to 401 — never log token bytes.
      return null;
    }
  }

  return null;
}

/**
 * Wrap a route handler with default-deny auth.
 *
 * @example
 *   export const POST = requireBoardAuth(
 *     "/api/governance/decisions",
 *     async (req, { username }) => { ... }
 *   );
 */
export function requireBoardAuth<Ctx = unknown>(
  routePath: string,
  handler: (
    req: NextRequest,
    identity: BoardIdentity,
    ctx: Ctx
  ) => Promise<Response> | Response
): (req: NextRequest, ctx: Ctx) => Promise<Response> {
  return async (req: NextRequest, ctx: Ctx) => {
    if (isPublicRoute(req, routePath)) {
      // Public routes get a stub identity so handlers can still call the
      // signature with the same shape — but `source` is `"jwt"` with no
      // username, signalling "unauthenticated public" to handler code that
      // chooses to introspect.
      return handler(
        req,
        { username: "", sub: "", source: "jwt", scope: [] },
        ctx
      );
    }
    const identity = await resolveBoardIdentity(req);
    if (!identity) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return handler(req, identity, ctx);
  };
}
