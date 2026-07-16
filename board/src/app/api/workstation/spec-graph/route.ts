import { NextRequest, NextResponse } from "next/server";
import { getGitHubToken, getUsername } from "@/lib/auth";
import { getOpsAuthHeaders } from "@/lib/ops-proxy";

const OPS_API_URL = process.env.OPS_API_URL || "http://localhost:3001";

/**
 * Proxy spec graph queries to the autobot-inbox API.
 *
 * GET ?action=impact&section=N        — impact analysis for §N
 * GET ?action=cross-refs&section=N    — cross-references for §N
 * GET ?action=status                  — implementation status per section
 * GET ?action=agent-context&agent=X   — spec context for agent X
 * POST (body: { action: "reseed" })   — re-seed spec graph
 */
export async function GET(req: NextRequest) {
  const ghToken = await getGitHubToken(req);
  const username = await getUsername(req);
  if (!ghToken || !username) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  if (!action) {
    return NextResponse.json({ error: "action parameter required" }, { status: 400 });
  }

  const opsHeaders = await getOpsAuthHeaders(req);
  if (!opsHeaders) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    let endpoint: string;
    const params = new URLSearchParams();

    switch (action) {
      case "impact": {
        const section = url.searchParams.get("section");
        if (!section) return NextResponse.json({ error: "section parameter required" }, { status: 400 });
        endpoint = "impact";
        params.set("section", section);
        break;
      }
      case "cross-refs": {
        const section = url.searchParams.get("section");
        if (!section) return NextResponse.json({ error: "section parameter required" }, { status: 400 });
        endpoint = "cross-refs";
        params.set("section", section);
        break;
      }
      case "status":
        endpoint = "status";
        break;
      case "agent-context": {
        const agent = url.searchParams.get("agent");
        if (!agent) return NextResponse.json({ error: "agent parameter required" }, { status: 400 });
        endpoint = "agent-context";
        params.set("agent", agent);
        break;
      }
      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }

    const apiUrl = `${OPS_API_URL}/api/spec-graph/${endpoint}?${params.toString()}`;
    const res = await fetch(apiUrl, {
      headers: opsHeaders,
    });

    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Proxy error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const ghToken = await getGitHubToken(req);
  const username = await getUsername(req);
  if (!ghToken || !username) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { action: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body.action !== "reseed") {
    return NextResponse.json({ error: `Unknown action: ${body.action}` }, { status: 400 });
  }

  const opsHeaders = await getOpsAuthHeaders(req);
  if (!opsHeaders) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const res = await fetch(`${OPS_API_URL}/api/spec-graph/reseed`, {
      method: "POST",
      headers: opsHeaders,
    });

    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Proxy error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
