import { NextRequest, NextResponse } from "next/server";
import { getGitHubToken, getUsername } from "@/lib/auth";
import { getOpsAuthHeaders } from "@/lib/ops-proxy";

const OPS_API_URL = process.env.OPS_API_URL || "http://localhost:3001";
const FETCH_TIMEOUT_MS = 10_000;

/**
 * GET /api/graph/entity/[id]?since=7d
 *
 * Bundled subgraph endpoint for the Knowledge Graph Tier 1 entity-lens view.
 * Returns the focus entity, 1-hop neighbors, typed edges (with strength), and
 * an inspector bundle (threads + top connections) in a single round-trip.
 *
 * When the ops backend does not yet expose /api/graph/entity/:id, we
 * synthesise a minimal response from the existing contacts / organizations /
 * topics signal endpoints so the UI always has something to render.
 *
 * Assumptions (per spec §5 "bundled endpoint"):
 *   - 1-hop only — Tier 2 multi-hop deferred to a future milestone.
 *   - `summary` field may be null — "no summary — ask Optimus" CTA is shown.
 *   - `since` defaults to "30d"; "7d" activates the recency-fade toggle.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const ghToken = await getGitHubToken(req);
  const username = await getUsername(req);
  if (!ghToken || !username) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const headers = await getOpsAuthHeaders(req);
  if (!headers) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const since = url.searchParams.get("since") || "30d";

  try {
    // Try the native ops endpoint first (may not exist yet — graceful fallback)
    const nativeRes = await fetch(
      `${OPS_API_URL}/api/graph/entity/${encodeURIComponent(id)}?since=${since}`,
      { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
    ).catch(() => null);

    if (nativeRes?.ok) {
      const data = await nativeRes.json();
      return NextResponse.json(data);
    }

    // ── Fallback: synthesise from existing signal endpoints ─────────────────
    // Resolve entity type + label by trying contacts then orgs then topics.
    const [contactRes, orgRes] = await Promise.all([
      fetch(`${OPS_API_URL}/api/contacts/${encodeURIComponent(id)}`, {
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }).catch(() => null),
      fetch(`${OPS_API_URL}/api/organizations/${encodeURIComponent(id)}`, {
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }).catch(() => null),
    ]);

    type EntityType = "person" | "organization" | "topic";
    let entityType: EntityType = "person";
    let label = id;
    let initials = "";
    let rawData: Record<string, unknown> = {};

    if (contactRes?.ok) {
      rawData = await contactRes.json();
      entityType = "person";
      label = (rawData.name as string) || (rawData.email as string) || id;
      initials = label
        .split(" ")
        .slice(0, 2)
        .map((w: string) => w[0]?.toUpperCase() ?? "")
        .join("");
    } else if (orgRes?.ok) {
      rawData = await orgRes.json();
      entityType = "organization";
      label = (rawData.name as string) || id;
    } else {
      // Assume topic
      entityType = "topic";
      label = id.replace(/-/g, " ");
    }

    // Fetch 1-hop relationships from the relationships endpoint
    const relRes = await fetch(
      `${OPS_API_URL}/api/contacts/${encodeURIComponent(id)}/relationships?limit=10`,
      { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
    ).catch(() => null);

    type RelationshipItem = {
      id: string;
      name?: string;
      type?: string;
      strength?: number;
      relationship_type?: string;
    };

    const relationships: RelationshipItem[] =
      relRes?.ok ? ((await relRes.json()) as RelationshipItem[]) : [];

    // Fetch recent threads
    const threadsRes = await fetch(
      `${OPS_API_URL}/api/contacts/${encodeURIComponent(id)}/threads?limit=5`,
      { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
    ).catch(() => null);

    type ThreadItem = {
      subject?: string;
      thread_id?: string;
      id?: string;
      created_at?: string;
      date?: string;
    };

    const threads: ThreadItem[] =
      threadsRes?.ok ? ((await threadsRes.json()) as ThreadItem[]) : [];

    // Build ReactFlow nodes + edges
    const now = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const recentActivity =
      rawData.last_seen_at
        ? now - new Date(rawData.last_seen_at as string).getTime() < sevenDaysMs
        : false;

    const focusNode = {
      id,
      type: entityType,
      label,
      data: { initials, recentActivity },
    };

    const rfNodes = [
      {
        id,
        type: `kg-${entityType}`,
        position: { x: 0, y: 0 },
        data: {
          label,
          initials,
          recentActivity,
          focused: true,
          entityType,
        },
      },
      ...relationships.map((rel, i) => {
        const angle = (2 * Math.PI * i) / Math.max(relationships.length, 1);
        const radius = 200;
        return {
          id: rel.id,
          type: `kg-${(rel.type as string) || "person"}`,
          position: {
            x: Math.round(radius * Math.cos(angle)),
            y: Math.round(radius * Math.sin(angle)),
          },
          data: {
            label: rel.name || rel.id,
            initials: (rel.name || rel.id)
              .split(" ")
              .slice(0, 2)
              .map((w: string) => w[0]?.toUpperCase() ?? "")
              .join(""),
            recentActivity: false,
            focused: false,
            entityType: (rel.type as string) || "person",
          },
        };
      }),
    ];

    const rfEdges = relationships.map((rel) => ({
      id: `${id}-${rel.id}`,
      source: id,
      target: rel.id,
      type: "default",
      data: {
        strength: rel.strength ?? 1,
        relationshipType: rel.relationship_type || "MENTIONED",
      },
      style: {
        stroke: "#52525b",
        strokeWidth: Math.min(4, Math.max(1, (rel.strength ?? 1) * 2)),
        opacity:
          rel.relationship_type === "MENTIONED" ||
          rel.relationship_type === "ATTENDED"
            ? 0.4
            : 1,
        strokeDasharray:
          rel.relationship_type === "COLLABORATED_ON_PROJECT"
            ? "6 3"
            : rel.relationship_type === "MEMBER_OF"
              ? "2 2"
              : undefined,
      },
    }));

    const inspector = {
      summary: null as string | null, // no RAG synthesis in fallback — CTA shown
      threads: threads.slice(0, 5).map((t) => ({
        subject: t.subject || "(no subject)",
        threadId: t.thread_id || t.id || "",
        age: t.created_at || t.date || "",
      })),
      connections: relationships
        .sort((a, b) => (b.strength ?? 0) - (a.strength ?? 0))
        .slice(0, 5)
        .map((rel) => ({
          id: rel.id,
          label: rel.name || rel.id,
          strength: rel.strength ?? 1,
        })),
    };

    return NextResponse.json({
      focus: focusNode,
      nodes: rfNodes,
      edges: rfEdges,
      inspector,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Proxy error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
