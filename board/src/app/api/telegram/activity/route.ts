/**
 * Telegram activity proxy — board-tier route forwarding to the ops backend.
 * OPT-74: Telegram inbound/outbound observability panel.
 *
 * GET /api/telegram/activity?limit=50&since=<iso>
 *   → proxies to ops backend GET /api/telegram/activity
 *
 * GET /api/telegram/status
 *   is served via the existing /api/ops proxy (/api/telegram prefix is allow-listed).
 *   This dedicated route exists for clean namespacing and board-tier auth enforcement.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";

const API_URL = process.env.OPS_API_URL || "http://localhost:3001";
const API_SECRET = process.env.OPS_API_SECRET || process.env.API_SECRET || "";
const FETCH_TIMEOUT_MS = 10_000;

export async function GET(req: NextRequest) {
  if (!API_SECRET) {
    return NextResponse.json(
      { error: "OPS_API_SECRET not configured" },
      { status: 500 }
    );
  }

  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const boardUser =
    session.user?.username ?? session.user?.name ?? "unknown";

  try {
    const url = new URL(req.url);
    const upstream = new URL(`${API_URL}/api/telegram/activity`);
    // Forward limit and since query params if present
    const limit = url.searchParams.get("limit");
    const since = url.searchParams.get("since");
    if (limit) upstream.searchParams.set("limit", limit);
    if (since) upstream.searchParams.set("since", since);

    const res = await fetch(upstream.toString(), {
      headers: {
        Authorization: `Bearer ${API_SECRET}`,
        "X-Board-User": boardUser,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Backend error" }));
      return NextResponse.json(err, { status: res.status });
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "Backend unreachable" }, { status: 502 });
  }
}
