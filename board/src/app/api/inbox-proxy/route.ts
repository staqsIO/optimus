import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/next-auth-options";
import { boardAuthHeadersFromIdentity } from "@/lib/board-auth-header";

const INBOX_API_URL = process.env.INBOX_API_URL || process.env.OPS_API_URL || "http://localhost:3001";

/**
 * ADR-019 / OPT-148: board-human identity travels as a short-lived RS256 board
 * JWT minted from the verified NextAuth session, NOT the shared INBOX_API_SECRET
 * + spoofable `x-board-user` header. Returns `null` when no username is
 * resolvable (caller 401s — deny by default).
 */
function inboxBoardHeaders(
  session:
    | { user?: { username?: string | null; boardMemberId?: string | null } }
    | null
    | undefined,
): Record<string, string> | null {
  const username = session?.user?.username ?? null;
  if (!username) return null;
  return boardAuthHeadersFromIdentity({
    username,
    boardMemberId: session?.user?.boardMemberId ?? null,
  });
}

// Exact-match paths
const ALLOWED_PATHS = [
  // Settings / system
  "/api/gates",
  "/api/gates/readiness",
  "/api/gates/measure",
  "/api/phase/current",
  "/api/phase/dead-man-switch",
  "/api/phase/dead-man-switch/renew",
  "/api/phase/exploration",
  "/api/runners",
  "/api/phase/activate",
  "/api/system/halt",
  "/api/system/resume",
  "/api/halt",
  "/api/resume",
  "/api/halt-status",

  "/api/stats",
  "/api/status",
  "/api/accounts",
  "/api/emails/archive",
  "/api/emails/unarchive",
  "/api/voice/bootstrap",
  "/api/voice/rebuild",
  // Drafts
  "/api/drafts",
  "/api/drafts/approve",
  "/api/drafts/reject",
  "/api/drafts/send",
  "/api/drafts/send-approved",
  "/api/drafts/bulk",
  // Today / Signals
  "/api/today",
  "/api/today/meetings",
  "/api/today/meeting-attendees",
  "/api/meetings",
  "/api/calendar/months",
  "/api/calendar/day",
  "/api/signals",
  "/api/signals/feed",
  "/api/signals/briefings",
  "/api/signals/resolve",
  "/api/signals/feedback",
  // Pipeline
  "/api/debug/pipeline",
  // Board (Kanban) — see board/docs/adr/003-route-and-api-contract.md
  "/api/board",
  // Briefing (used by drafts page for stats)
  "/api/briefing",
  // Signals unresolve (used by undo)
  "/api/signals/unresolve",
  // Drafts edit
  "/api/drafts/edit",
  // Email body (used by expanded views)
  "/api/emails/body",
  // Pipeline retry + timeline (replay)
  "/api/pipeline/stuck/retry",
  "/api/pipeline/timeline",
  // Settings (connected accounts, voice, keys, auth)
  "/api/voice/status",
  "/api/voice/profiles",
  "/api/voice/edits",
  "/api/accounts/disconnect",
  "/api/accounts/delete",
  "/api/accounts/resync",
  "/api/accounts/activate",
  "/api/contacts/sync",
  "/api/settings/keys",
  "/api/transcripts/status",
  "/api/transcripts/backfill-tldv",
  "/api/transcripts/backfill-tldv-messages",
  "/api/auth/gmail-url",
  "/api/board-members",
  // Knowledge Base
  "/api/documents",
  "/api/documents/stats",
  "/api/documents/detail",
  "/api/documents/ingest",
  "/api/documents/ingest-email",
  "/api/documents/ingest-drive",
  "/api/documents/embed-pending",
  "/api/documents/reembed",
  "/api/documents/search",
  "/api/search",
  "/api/search/stats",
  // Human tasks — PRD: meeting-actions-to-kanban
  "/api/human-tasks",
  // v0.2 tech-spec §4.1 — guardrails, Linear backfill, today, engagements, projects
  "/api/guardrails",
  "/api/guardrails/history",
  "/api/guardrails/decisions",
  "/api/guardrails/correction",
  "/api/linear/backfill/preview",
  "/api/linear/backfill",
  "/api/linear/team-cache",
  "/api/linear/team-cache/refresh",
  "/api/linear/workflow-states",
  "/api/linear/reconcile",
  "/api/today/tasks",
  "/api/today/linear",
  "/api/engagements",
  "/api/projects",
  // Observability — scheduled services (STAQPRO-537)
  "/api/services/status",
  // STAQPRO-532 — read-only GitHub PR/issue activity (org-shared, viewer-scoped backend)
  "/api/github/activity",
  // Plan 040 — read-only Telegram comms observability (board-role backend, shared channel)
  "/api/telegram/activity",
  "/api/telegram/status",
];

// Prefix-match paths (dynamic segments like /api/contacts/:id)
const ALLOWED_PREFIXES = [
  "/api/contacts/",
  "/api/accounts/",
  "/api/drive/",
  "/api/calendar/",
  "/api/emails/",
  "/api/auth/",
  "/api/documents/",
  "/api/board-members/",
  "/api/runners/",
  // Board skip endpoints — see board/docs/adr/005-skip-needs-you-items.md
  "/api/board/proposals/",
  "/api/board/attention/",
  // Human tasks — action + inline-answer + lifecycle + fields + push dynamic routes
  "/api/human-tasks/",
  // v0.2 tech-spec §4.1 — covers /api/guardrails/{...}, /api/linear/backfill/{id}[/cancel],
  // /api/today/{...}, /api/engagements/{id}, /api/projects/{id}
  "/api/guardrails/",
  "/api/linear/backfill/",
  "/api/linear/",
  "/api/today/",
  "/api/engagements/",
  "/api/projects/",
  // Observability — covers /api/services/:name/{pause,resume,trigger} (STAQPRO-537)
  "/api/services/",
  // OPT-2 — Provenance chain: /api/provenance/:source_meeting_id (read-only, board-scoped)
  "/api/provenance/",
];

// Plan 040 — read-only endpoints that must never be reachable through the POST
// proxy. These are observability GETs (Telegram/GitHub/services activity +
// status) with no write semantics; the board only ever reads them via the GET
// proxy (inboxGet/opsFetch). Excluding them from the POST allow-check prevents a
// POST-through-proxy from reaching a GET-only backend route (deny by default, P1).
// Exact-match only, so sibling write routes under the same prefix (e.g.
// /api/services/:name/{pause,resume,trigger}) still POST through normally.
const GET_ONLY_PATHS = new Set([
  "/api/telegram/activity",
  "/api/telegram/status",
  "/api/github/activity",
  "/api/services/status",
]);

function isPathAllowed(path: string): boolean {
  const pathOnly = path.split("?")[0]; // strip query params for allowlist check
  if (ALLOWED_PATHS.includes(pathOnly)) return true;
  return ALLOWED_PREFIXES.some((prefix) => pathOnly.startsWith(prefix));
}

/**
 * POST-side allow-check: same allowlist as GET, minus the GET-only read
 * endpoints. Blocks a POST-through-proxy to a path that is only meant to be
 * read via GET.
 */
function isPostPathAllowed(path: string): boolean {
  const pathOnly = path.split("?")[0];
  if (GET_ONLY_PATHS.has(pathOnly)) return false;
  return isPathAllowed(path);
}

/**
 * Generic GET proxy -- forwards authenticated GET requests to the inbox backend.
 * Client sends ?path=/api/... and this route adds the Authorization header.
 */
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const path = req.nextUrl.searchParams.get("path");
    if (!path || !isPathAllowed(path)) {
      return NextResponse.json({ error: "Path not allowed" }, { status: 403 });
    }

    // ADR-019: identity is carried by a verified board JWT (signature-checked by
    // the backend), not the shared secret + spoofable header. owner-scoping
    // continues to work because the backend reads github_username from the
    // verified JWT claims.
    const getHeaders = inboxBoardHeaders(session);
    if (!getHeaders) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const res = await fetch(`${INBOX_API_URL}${path}`, {
      headers: getHeaders,
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

/**
 * Generic POST proxy -- forwards any POST to the inbox backend with Bearer auth.
 * The client sends { path, body } and this route adds the Authorization header
 * server-side so the secret never reaches the browser.
 */
export async function POST(req: NextRequest) {
  const postSession = await getServerSession(authOptions);
  if (!postSession) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { path, body, method: methodOverride } = await req.json();
    if (!path || typeof path !== "string") {
      return NextResponse.json({ error: "Path not allowed" }, { status: 403 });
    }
    // Gate on the EFFECTIVE forwarded verb, not the fact this handler is POST.
    // A method:"GET" override resolves to a real backend GET, so it gets the GET
    // ruleset (isPathAllowed — GET-only read endpoints permitted); a true POST
    // gets the write ruleset (isPostPathAllowed — GET-only reads excluded).
    const httpMethod = (methodOverride === "GET" ? "GET" : "POST");
    const pathAllowed =
      httpMethod === "GET" ? isPathAllowed(path) : isPostPathAllowed(path);
    if (!pathAllowed) {
      return NextResponse.json({ error: "Path not allowed" }, { status: 403 });
    }
    // ADR-019: identity via verified board JWT, not shared secret + header.
    const authHeaders = inboxBoardHeaders(postSession);
    if (!authHeaders) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const headers: Record<string, string> = { ...authHeaders };
    if (httpMethod === "POST") {
      headers["Content-Type"] = "application/json";
    }

    const res = await fetch(`${INBOX_API_URL}${path}`, {
      method: httpMethod,
      headers,
      body: httpMethod === "POST" && body != null ? JSON.stringify(body) : undefined,
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
