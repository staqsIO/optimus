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
  const path = searchParams.get("path") || "/api/governance/submissions";

  // Whitelist allowed backend paths
  if (!path.startsWith("/api/governance/")) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  // Forward all other search params
  const forwardParams = new URLSearchParams();
  searchParams.forEach((val, key) => {
    if (key !== "path") forwardParams.set(key, val);
  });

  const url = `${API_URL}${path}${forwardParams.toString() ? `?${forwardParams}` : ""}`;

  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(10000),
    });

    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    console.error("[governance proxy] GET error:", err);
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
  const path = searchParams.get("path") || "/api/governance/submit";

  // Whitelist allowed backend paths
  if (!path.startsWith("/api/governance/")) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  const url = `${API_URL}${path}`;

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
    console.error("[governance proxy] POST error:", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 502 });
  }
}
