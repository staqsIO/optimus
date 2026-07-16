import { NextRequest, NextResponse } from "next/server";
import { getOpsAuthHeaders } from "@/lib/ops-proxy";

const API_URL =
  process.env.OPS_API_URL || process.env.API_URL || "http://localhost:3001";

export async function POST(req: NextRequest) {
  const headers = await getOpsAuthHeaders(req);
  if (!headers) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const url = `${API_URL}/api/governance/classify-intent`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(6000),
    });

    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    console.error("[governance proxy] classify-intent error:", err);
    // Return a safe default so the frontend can still route
    return NextResponse.json({ intent: "ask", confidence: 0 }, { status: 200 });
  }
}
