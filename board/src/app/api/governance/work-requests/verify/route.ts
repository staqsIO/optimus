import { NextRequest, NextResponse } from "next/server";
import { getOpsAuthHeaders } from "@/lib/ops-proxy";

const API_URL =
  process.env.OPS_API_URL || process.env.API_URL || "http://localhost:3001";

/**
 * Hub Wedge C proxy — board marks acceptance-criteria results at review.
 * POST -> /api/intents/authored/criteria. Board-only is enforced backend-side; the
 * RS256 board JWT carries the verified identity (the backend never trusts a header).
 */
export async function POST(req: NextRequest) {
  const headers = await getOpsAuthHeaders(req);
  if (!headers) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Board-tier shape gate: forward only the expected fields, not arbitrary client
  // JSON. The backend re-validates (P2), but the proxy is the board-tier boundary —
  // don't let a session holder inject extra fields into the downstream POST.
  const raw = (body ?? {}) as Record<string, unknown>;
  if (typeof raw.workItemId !== "string" || !Array.isArray(raw.results)) {
    return NextResponse.json(
      { error: "Invalid payload: expected { workItemId: string, results: [] }" },
      { status: 400 }
    );
  }
  const forward = { workItemId: raw.workItemId, results: raw.results };

  try {
    const res = await fetch(`${API_URL}/api/intents/authored/criteria`, {
      method: "POST",
      headers,
      body: JSON.stringify(forward),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    console.error("[work-requests verify proxy] POST error:", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 502 });
  }
}
