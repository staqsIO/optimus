import { NextRequest, NextResponse } from "next/server";
import { getOpsAuthHeaders } from "@/lib/ops-proxy";

const API_URL =
  process.env.OPS_API_URL || process.env.API_URL || "http://localhost:3001";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const headers = await getOpsAuthHeaders(req);
  if (!headers) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const url = `${API_URL}/api/governance/submission?id=${encodeURIComponent(id)}`;

  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(10000),
    });

    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    console.error("[governance proxy] GET detail error:", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 502 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const headers = await getOpsAuthHeaders(req);
  if (!headers) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const body = await req.json();
  const { action, ...rest } = body;

  // Route to correct backend endpoint based on action
  let path: string;
  if (action === "decide") {
    path = "/api/governance/submissions/decide";
  } else if (action === "discuss") {
    path = "/api/governance/submissions/discuss";
  } else if (action === "confirm-extractions") {
    path = "/api/governance/submissions/confirm-extractions";
  } else {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  const url = `${API_URL}${path}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ id, ...rest }),
      signal: AbortSignal.timeout(30000),
    });

    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    console.error("[governance proxy] POST action error:", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 502 });
  }
}
