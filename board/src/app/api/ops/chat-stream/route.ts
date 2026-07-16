import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";

const API_URL = process.env.OPS_API_URL || "http://localhost:3001";
const API_SECRET = process.env.OPS_API_SECRET || process.env.API_SECRET || "";

/**
 * Streaming chat proxy: Board → Backend POST /api/chat/stream.
 *
 * Pipes the backend's SSE response body straight through (same pattern as
 * /api/ops/events) with NO AbortSignal.timeout — long generations are not
 * subject to the 60s chat proxy timeout. The client's abort (Stop button /
 * tab close) propagates via req.signal so the backend stream and its LLM
 * call are torn down instead of burning tokens into a dead connection.
 */
export async function POST(req: NextRequest) {
  if (!API_SECRET) {
    return new Response("OPS_API_SECRET not configured", { status: 500 });
  }

  const session = await getSession();
  // Hard auth gate: chat triggers budget accounting, RAG, and LLM spend —
  // an unauthenticated request must never reach the backend as "unknown".
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }
  // STAQPRO-531: forward the unambiguous github `username`; display `name`
  // only as a fallback for sessions whose JWT predates the field.
  const boardUser = session.user?.username ?? session.user?.name ?? "unknown";

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const upstream = await fetch(`${API_URL}/api/chat/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_SECRET}`,
      "X-Board-User": boardUser,
    },
    body: JSON.stringify(body),
    signal: req.signal,
  });

  if (!upstream.ok || !upstream.body) {
    const err = await upstream.text().catch(() => "Backend error");
    return new Response(err || "Backend SSE unavailable", {
      status: upstream.status || 502,
    });
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
