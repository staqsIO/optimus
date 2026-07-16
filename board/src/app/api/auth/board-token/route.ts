/**
 * POST /api/auth/board-token
 *
 * Mints a short-lived board JWT for the calling NextAuth session.
 * The browser/client stores the returned token in memory (NOT localStorage)
 * and attaches it as `Authorization: Bearer <token>` on subsequent
 * server-to-server calls to autobot-inbox.
 *
 * P1: deny by default — requires a valid NextAuth session, otherwise 401.
 * P2: identity is read from the verified session token, never from the body.
 * P3: emits a single info log per mint (no token bytes).
 */

import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { issueBoardToken } from "@/lib/board-jwt";

export async function POST(req: NextRequest): Promise<Response> {
  const sessionToken = await getToken({ req });
  const username =
    typeof sessionToken?.username === "string" ? sessionToken.username : null;
  if (!username) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const boardMemberId =
    typeof sessionToken?.boardMemberId === "string"
      ? sessionToken.boardMemberId
      : username; // fall back to username when board_members.id isn't loaded

  const { token, expiresAt, jti } = issueBoardToken(boardMemberId, username);

  // Surface non-secret metadata for client-side TTL handling and audit.
  return NextResponse.json(
    {
      token,
      expiresAt,
      jti,
      username,
    },
    {
      // Tokens MUST NOT be cached by any intermediary.
      headers: { "Cache-Control": "no-store, max-age=0" },
    }
  );
}
