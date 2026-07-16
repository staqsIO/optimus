import { NextRequest, NextResponse } from "next/server";
import { getOpsAuthHeaders } from "@/lib/ops-proxy";

const API_URL =
  process.env.OPS_API_URL || process.env.API_URL || "http://localhost:3001";

export async function GET(req: NextRequest) {
  const headers = await getOpsAuthHeaders(req);
  if (!headers) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status") || "pending";

  const url = `${API_URL}/api/decisions?status=${encodeURIComponent(status)}`;

  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(10000),
    });

    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    console.error("[governance proxy] GET decisions error:", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const headers = await getOpsAuthHeaders(req);
  if (!headers) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  const action = searchParams.get("action");

  if (!id || !action) {
    return NextResponse.json(
      { error: "Missing id or action param" },
      { status: 400 }
    );
  }

  const allowedActions = ["verdict", "reverse"];
  if (!allowedActions.includes(action)) {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }

  const url = `${API_URL}/api/decisions/${encodeURIComponent(id)}/${action}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });

    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    console.error("[governance proxy] POST decisions error:", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 502 });
  }
}
