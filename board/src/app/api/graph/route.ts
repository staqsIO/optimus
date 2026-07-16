import { NextRequest, NextResponse } from "next/server";
import { getGitHubToken, getUsername } from "@/lib/auth";
import { getOpsAuthHeaders } from "@/lib/ops-proxy";

const OPS_API_URL = process.env.OPS_API_URL || "http://localhost:3001";

/**
 * Unified graph data API — aggregates spec graph, agent topology,
 * and signal flow into a single response for the graph visualizer.
 *
 * GET ?view=unified  — full graph (spec + agents + signals)
 * GET ?view=spec     — spec sections + cross-references only
 * GET ?view=agents   — agent topology + delegation edges
 * GET ?view=signals  — signal flow across channels
 */
export async function GET(req: NextRequest) {
  const ghToken = await getGitHubToken(req);
  const username = await getUsername(req);
  if (!ghToken || !username) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const view = url.searchParams.get("view") || "unified";
  const accountId = url.searchParams.get("account_id"); // Optional: filter by account
  // Per-user JWT instead of shared OPS_API_SECRET — the caller above already
  // passed the NextAuth gate, so this just re-derives the headers in JWT form.
  const headers = await getOpsAuthHeaders(req);
  if (!headers) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const results: Record<string, unknown> = {};

    // Fetch spec graph data
    if (view === "unified" || view === "spec") {
      const [statusRes, crossRefsRes] = await Promise.all([
        fetch(`${OPS_API_URL}/api/spec-graph/status`, { headers }).then(r => r.json()).catch(() => null),
        // Get cross-refs for all sections (we'll aggregate)
        fetch(`${OPS_API_URL}/api/spec-graph/impact?section=0`, { headers }).then(r => r.json()).catch(() => null),
      ]);
      results.spec = {
        status: statusRes,
        impact: crossRefsRes,
      };
    }

    // Fetch agent topology + backfill from agents.json config
    if (view === "unified" || view === "agents") {
      const [topoRes, configRes] = await Promise.all([
        fetch(`${OPS_API_URL}/api/governance/topology`, { headers }).then(r => r.json()).catch(() => null),
        fetch(`${OPS_API_URL}/api/agents/config`, { headers }).then(r => r.json()).catch(() => null),
      ]);

      // Merge agents from config that aren't already in topology
      if (topoRes && configRes?.agents) {
        const topoNodeIds = new Set((topoRes.nodes || []).map((n: { id: string }) => n.id));
        const configAgents = configRes.agents as Record<string, { id: string; type: string; model: string; enabled?: boolean; capabilities?: string[] }>;
        const backfilled = Object.values(configAgents)
          .filter(a => !topoNodeIds.has(a.id))
          .map(a => ({
            id: a.id,
            tier: a.type,
            model: a.model,
            recentTasks: 0,
            recentSuccesses: 0,
            capabilities: a.capabilities || [],
            enabled: a.enabled,
          }));

        topoRes.nodes = [...(topoRes.nodes || []), ...backfilled];
      }

      results.topology = topoRes;
    }

    // Fetch signal flow data (cross-channel counts)
    if (view === "unified" || view === "signals") {
      const signalRes = await fetch(`${OPS_API_URL}/api/governance/signals-summary`, { headers })
        .then(r => r.json())
        .catch(() => null);
      results.signals = signalRes;
    }

    // Fetch bot-scope config for architecture graph bypass paths
    if (view === "unified" || view === "agents") {
      const configGates = await fetch(`${OPS_API_URL}/api/config/bot-scope`, { headers })
        .then(r => r.json())
        .catch(() => null);
      if (configGates) {
        results.configGates = configGates;
      }
    }

    // Include account context in response
    if (accountId) {
      results.accountFilter = accountId;
    }

    return NextResponse.json(results);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Proxy error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
