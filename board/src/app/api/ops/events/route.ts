import { getSession } from "@/lib/auth";

const API_URL = process.env.OPS_API_URL || "http://localhost:3001";
const API_SECRET = process.env.OPS_API_SECRET || process.env.API_SECRET || "";

/**
 * SSE proxy: Board → Backend /api/events.
 * Streams typed events (heartbeat, state_changed, campaign_update, hitl_request, etc.)
 * to the Board's EventStreamProvider via a single long-lived connection.
 */
export async function GET() {
  if (!API_SECRET) {
    return new Response("OPS_API_SECRET not configured", { status: 500 });
  }

  const session = await getSession();
  // Hard auth gate: never open a backend SSE stream for an unauthenticated
  // client (previously degraded to X-Board-User: "unknown").
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }
  const boardUser = session.user?.username ?? session.user?.name ?? "unknown";

  const upstream = await fetch(`${API_URL}/api/events`, {
    headers: {
      Authorization: `Bearer ${API_SECRET}`,
      "X-Board-User": boardUser,
    },
  });

  if (!upstream.ok || !upstream.body) {
    return new Response("Backend SSE unavailable", { status: 502 });
  }

  // Pipe the upstream SSE stream directly to the client
  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
