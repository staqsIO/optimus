import { NextRequest, NextResponse } from "next/server";
import { getOpsAuth } from "@/lib/ops-proxy";

const OPS_API_URL = process.env.OPS_API_URL || "http://localhost:3001";

/**
 * GET /api/workstation/proposals?status=pending
 * Proxies to autobot-inbox GET /api/spec-proposals
 */
export async function GET(req: NextRequest) {
  const auth = await getOpsAuth(req);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status");
  const limit = searchParams.get("limit");

  const qs = new URLSearchParams();
  if (status) qs.set("status", status);
  if (limit) qs.set("limit", limit);
  const qsStr = qs.toString();

  const res = await fetch(
    `${OPS_API_URL}/api/spec-proposals${qsStr ? `?${qsStr}` : ""}`,
    { headers: auth.headers }
  );

  if (!res.ok) {
    return NextResponse.json(
      { error: "Failed to fetch proposals from ops backend" },
      { status: res.status }
    );
  }

  const data = await res.json();
  return NextResponse.json(data);
}

/**
 * POST /api/workstation/proposals
 * Body: { id, action, feedback }
 *   - If `id` is present: update proposal status (approve/reject/revision-requested)
 *   - If `id` is absent: create a new proposal (agent-facing, rarely used from dashboard)
 */
export async function POST(req: NextRequest) {
  const auth = await getOpsAuth(req);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();

  // Route: update an existing proposal
  if (body.id && body.action) {
    const { id, action, feedback } = body;

    // Validate proposal ID format to prevent path traversal
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
      return NextResponse.json(
        { error: "Invalid proposal id" },
        { status: 400 }
      );
    }

    const validActions = ["approved", "rejected", "revision-requested"];
    if (!validActions.includes(action)) {
      return NextResponse.json(
        { error: `action must be one of: ${validActions.join(", ")}` },
        { status: 400 }
      );
    }

    const res = await fetch(`${OPS_API_URL}/api/spec-proposals/${id}`, {
      method: "POST",
      headers: auth.headers,
      body: JSON.stringify({
        status: action,
        board_feedback: feedback || null,
        // Identity from verified session, not from body.
        reviewed_by: auth.caller.username,
      }),
    });

    if (!res.ok) {
      const errData = await res
        .json()
        .catch(() => ({ error: "Unknown error" }));
      return NextResponse.json(errData, { status: res.status });
    }

    const data = await res.json();
    return NextResponse.json(data);
  }

  // Route: create a new proposal (pass-through)
  const res = await fetch(`${OPS_API_URL}/api/spec-proposals`, {
    method: "POST",
    headers: auth.headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({ error: "Unknown error" }));
    return NextResponse.json(errData, { status: res.status });
  }

  const data = await res.json();
  return NextResponse.json(data);
}
