import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";

const API_URL = process.env.OPS_API_URL || "http://localhost:3001";
const API_SECRET = process.env.OPS_API_SECRET || process.env.API_SECRET || "";
const FETCH_TIMEOUT_MS = 10_000;
const CHAT_FETCH_TIMEOUT_MS = 60_000; // Chat responses can take longer
const LONG_RUNNING_TIMEOUT_MS = 120_000; // Wiki compile, voice bootstrap, etc.
/** Research poll may chain wiki compile (LLM); allow extra headroom on the Board proxy. */
const RESEARCH_POLL_TIMEOUT_MS = 300_000;

// Paths that may take >10s (LLM calls, bulk processing). Only paths that pass
// the ALLOWED_PREFIXES allowlist below are reachable here — voice
// bootstrap/rebuild route through /api/inbox-proxy (not ops), and /api/feeds
// has no ops caller, so those are intentionally absent (STAQPRO-540).
const LONG_RUNNING_PATHS = new Set([
  '/api/projects/compile',
  '/api/contacts/sync',
  '/api/drive/watches/poll',
  '/api/research-sources/poll',
]);

// STAQPRO-540 (Ship-0): prefix allowlist for the /api/ops board channel.
//
// This is a REACHABILITY stopgap, not the data boundary. It constrains WHICH
// backend resource groups are reachable through this proxy (closing the
// "arbitrary /api/*" second door); it does NOT decide WHETHER a reachable
// endpoint scopes its data to the logged-in viewer. The actual authorization
// boundary is the backend route-tier classifier (STAQPRO-542 / ADR-009);
// this allowlist is defense-in-depth in front of it.
//
// Entries are resource-group roots derived from every ops* call site in
// board/src. A path is allowed when its pathname equals a root or sits under
// it (`root/...`). Control endpoints (halt/resume/phase/system) are
// deliberately absent — those route through /api/inbox-proxy, not here.
// Keep in sync when a board page starts calling a new /api/<group>.
const ALLOWED_PREFIXES = [
  "/api/accounts",
  "/api/actions",
  "/api/activity",
  "/api/agents",
  "/api/artifacts",
  "/api/audit",
  "/api/board-members",
  "/api/briefing",
  "/api/campaigns",
  "/api/capture-sources",
  "/api/chat",
  "/api/contacts",
  "/api/content",
  "/api/contracts",
  "/api/counterparties",
  "/api/deals",
  "/api/documents",
  "/api/drafts",
  "/api/drive",
  "/api/explorer",
  "/api/flows",
  "/api/github",
  "/api/governance",
  "/api/intents",
  "/api/meeting-registry",
  "/api/meetings",
  "/api/metrics",
  "/api/models",
  "/api/needs-attention",
  "/api/organizations",
  "/api/pipeline",
  "/api/preferences",
  "/api/projects",
  "/api/research-sources",
  "/api/runs",
  "/api/search",
  "/api/services",
  "/api/sharing",
  "/api/signals",
  "/api/signatures",
  "/api/stats",
  "/api/status",
  "/api/transcripts",
  "/api/triage",
  "/api/voice-prints",
  "/api/wiki",
] as const;

function isPathAllowed(pathname: string): boolean {
  return ALLOWED_PREFIXES.some(
    (root) => pathname === root || pathname.startsWith(`${root}/`),
  );
}

function validatePath(path: string | null): path is string {
  if (!path || typeof path !== "string") return false;
  if (!path.startsWith("/api/")) return false;
  if (path.includes("..") || /[@#]/.test(path)) return false;
  // Verify constructed URL resolves to expected origin
  try {
    const url = new URL(path, API_URL);
    const expected = new URL(API_URL);
    if (url.origin !== expected.origin) return false;
    // STAQPRO-540: match the allowlist on the pathname only, so query strings
    // (e.g. /api/signals?limit=6) cannot smuggle a non-allowlisted path.
    if (!isPathAllowed(url.pathname)) return false;
  } catch {
    return false;
  }
  return true;
}

export async function GET(req: NextRequest) {
  if (!API_SECRET) {
    return NextResponse.json({ error: "OPS_API_SECRET not configured" }, { status: 500 });
  }

  try {
    const path = req.nextUrl.searchParams.get("path");
    if (!validatePath(path)) {
      return NextResponse.json({ error: "Invalid path" }, { status: 400 });
    }

    const session = await getSession();
    // STAQPRO-531: backend resolveViewerEmails keys on github_username. Forward the
    // unambiguous `username` field 531 added; `name` (display-name slot) is only a
    // fallback for older sessions whose JWT predates the field. Do NOT revert to `name`.
    const boardUser = session?.user?.username ?? session?.user?.name ?? "unknown";
    const isChat = path.startsWith("/api/chat/");

    const res = await fetch(`${API_URL}${path}`, {
      headers: {
        Authorization: `Bearer ${API_SECRET}`,
        "X-Board-User": boardUser,
      },
      signal: AbortSignal.timeout(isChat ? CHAT_FETCH_TIMEOUT_MS : FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Backend error" }));
      return NextResponse.json(err, { status: res.status });
    }

    // Binary passthrough for file downloads
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("application/json")) {
      const buf = await res.arrayBuffer();
      const headers = new Headers();
      headers.set("Content-Type", ct);
      const cd = res.headers.get("content-disposition");
      if (cd) headers.set("Content-Disposition", cd);
      return new NextResponse(buf, { status: 200, headers });
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "Backend unreachable" }, { status: 502 });
  }
}

export async function PATCH(req: NextRequest) {
  if (!API_SECRET) {
    return NextResponse.json({ error: "OPS_API_SECRET not configured" }, { status: 500 });
  }

  try {
    const { path, body } = await req.json();
    if (!validatePath(path)) {
      return NextResponse.json({ error: "Invalid path" }, { status: 400 });
    }

    const session = await getSession();
    const boardUser = session?.user?.username ?? session?.user?.name ?? "unknown";

    const res = await fetch(`${API_URL}${path}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_SECRET}`,
        "X-Board-User": boardUser,
      },
      body: body != null ? JSON.stringify(body) : undefined,
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

export async function POST(req: NextRequest) {
  if (!API_SECRET) {
    return NextResponse.json({ error: "OPS_API_SECRET not configured" }, { status: 500 });
  }

  try {
    const { path, body } = await req.json();
    if (!validatePath(path)) {
      return NextResponse.json({ error: "Invalid path" }, { status: 400 });
    }

    const session = await getSession();
    const boardUser = session?.user?.username ?? session?.user?.name ?? "unknown";
    const isChat = path.startsWith("/api/chat/");
    const isContractEdit = /^\/api\/contracts\/[^/]+\/edit$/.test(path);
    const isResearchPoll = path === "/api/research-sources/poll";
    const isLongRunning = LONG_RUNNING_PATHS.has(path);
    const timeout = isChat || isContractEdit
      ? CHAT_FETCH_TIMEOUT_MS
      : isResearchPoll
        ? RESEARCH_POLL_TIMEOUT_MS
        : isLongRunning
          ? LONG_RUNNING_TIMEOUT_MS
          : FETCH_TIMEOUT_MS;

    const res = await fetch(`${API_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_SECRET}`,
        "X-Board-User": boardUser,
      },
      body: body != null ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
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

export async function DELETE(req: NextRequest) {
  if (!API_SECRET) {
    return NextResponse.json({ error: "OPS_API_SECRET not configured" }, { status: 500 });
  }

  try {
    const { path } = await req.json();
    if (!validatePath(path)) {
      return NextResponse.json({ error: "Invalid path" }, { status: 400 });
    }

    const session = await getSession();
    const boardUser = session?.user?.username ?? session?.user?.name ?? "unknown";

    const res = await fetch(`${API_URL}${path}`, {
      method: "DELETE",
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
