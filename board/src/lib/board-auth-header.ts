/**
 * Board-human Authorization header minting (OPT-148 / ADR-019).
 *
 * The board proxies (`ops/route.ts`, `inbox-proxy/route.ts`, `ops-proxy.ts`)
 * used to authenticate board-human calls with the shared `OPS_API_SECRET`
 * (opaque Bearer) and forward the verified GitHub username in `x-board-user`.
 * The backend then promoted that client-supplied header into board-member
 * identity — meaning any holder of the shared secret could forge any board
 * member. ADR-019 closes this: identity is now carried by a short-lived,
 * RS256-signed board JWT minted from the NextAuth-verified session.
 *
 * P1 (deny-by-default): no verified session → no token → caller is unauthorized
 *   upstream (the proxies already 401 before calling this).
 * P2 (infra enforces, headers advise): the backend verifies the JWT signature;
 *   it no longer trusts `x-board-user` for identity. `x-board-user` is kept ONLY
 *   as a human-readable audit hint and must never be the authorization source.
 *
 * The JWT is minted per request (RS256 sign is sub-millisecond; the 15-min TTL
 * means a cached token would expire mid-session — see ADR-019 §(e)).
 */

import { getToken } from "next-auth/jwt";
import type { NextRequest } from "next/server";
import { issueBoardToken } from "@/lib/board-jwt";

/** Minimal session shape the proxies already obtain via getServerSession. */
export interface BoardIdentity {
  username?: string | null;
  boardMemberId?: string | null;
}

/**
 * Mint the board-human Authorization header (`Bearer <board-jwt>`) plus the
 * audit-only `x-board-user` hint, from an already-verified identity.
 *
 * Returns `null` when no username is resolvable — callers MUST treat this as
 * unauthorized (deny by default) rather than falling back to the shared secret.
 */
export function boardAuthHeadersFromIdentity(
  identity: BoardIdentity,
): Record<string, string> | null {
  const username = identity.username ?? null;
  if (!username) return null;

  // sub = board_members.id (UUID) when known, else the GitHub username
  // (the backend verifier tolerates both). Never read from a request body.
  const sub = identity.boardMemberId ?? username;
  const { token } = issueBoardToken(sub, username);

  return {
    Authorization: `Bearer ${token}`,
    // Audit-only hint. The backend derives identity from the JWT signature,
    // NOT from this header. Forwarded purely so routes can log the actor.
    "x-board-user": username,
  };
}

/**
 * Mint the board-human Authorization header from a NextRequest by reading the
 * verified NextAuth JWT (same source as `/api/auth/board-token`).
 *
 * Returns `null` when the request has no valid session — caller must 401.
 */
export async function boardAuthHeadersFromRequest(
  req: NextRequest,
): Promise<Record<string, string> | null> {
  const sessionToken = await getToken({ req });
  const username =
    typeof sessionToken?.username === "string" ? sessionToken.username : null;
  if (!username) return null;
  const boardMemberId =
    typeof sessionToken?.boardMemberId === "string"
      ? sessionToken.boardMemberId
      : null;
  return boardAuthHeadersFromIdentity({ username, boardMemberId });
}
