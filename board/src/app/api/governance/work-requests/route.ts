import { NextRequest, NextResponse } from "next/server";
import { getOpsAuthHeaders } from "@/lib/ops-proxy";

const API_URL =
  process.env.OPS_API_URL || process.env.API_URL || "http://localhost:3001";

/**
 * Hub Wedge B proxy — human-authored work requests.
 *
 * GET  -> /api/intents/authored : render-back list (intent + work_item lifecycle).
 * POST -> /api/intents          : author a request. The acceptance-criteria
 *         contract is enforced backend-side (P2); the board JWT carries the
 *         verified author identity (the backend never trusts a client header).
 */
export async function GET(req: NextRequest) {
  const headers = await getOpsAuthHeaders(req);
  if (!headers) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const res = await fetch(`${API_URL}/api/intents/authored`, {
      headers,
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    console.error("[work-requests proxy] GET error:", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 502 });
  }
}

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

  // Deliberate transparent passthrough: the acceptance-criteria contract is
  // validated and enforced backend-side at POST /api/intents (P2). Validating
  // here too would duplicate the rule and risk drift.
  try {
    const res = await fetch(`${API_URL}/api/intents`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    console.error("[work-requests proxy] POST error:", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 502 });
  }
}
