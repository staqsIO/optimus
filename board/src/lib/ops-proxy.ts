import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { getGitHubToken } from "@/lib/auth";
import {
  boardAuthHeadersFromIdentity,
  boardAuthHeadersFromRequest,
} from "@/lib/board-auth-header";

const OPS_API_URL = process.env.OPS_API_URL || "http://localhost:3001";

/**
 * Board-human request headers: a short-lived RS256 board JWT (ADR-019) carries
 * the verified identity. The shared OPS_API_SECRET is NO LONGER used here — it
 * conferred forgeable board identity via the `x-board-user` header. Returns
 * `null` when no verified session is present (caller 401s — deny by default).
 */
async function opsHeaders(
  req: NextRequest,
): Promise<Record<string, string> | null> {
  const auth = await boardAuthHeadersFromRequest(req);
  if (!auth) return null;
  return { "Content-Type": "application/json", ...auth };
}

/**
 * Proxy a board route to the autobot-inbox ops API.
 *
 * Verifies the user via NextAuth, then forwards the call to OPS_API_URL with a
 * short-lived board JWT (ADR-019) so the backend derives identity from the
 * verified signature — not a client-supplied header.
 */
export async function proxyOps(
  req: NextRequest,
  opsPath: string,
  opts: {
    method?: string;
    body?: unknown;
    forwardQuery?: boolean;
  } = {}
): Promise<NextResponse> {
  const ghToken = await getGitHubToken(req);
  if (!ghToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const headers = await opsHeaders(req);
  if (!headers) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const qs = opts.forwardQuery && url.search ? url.search : "";
  const target = `${OPS_API_URL}${opsPath}${qs}`;

  const init: RequestInit = {
    method: opts.method || "GET",
    headers,
  };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
  }

  // Long-running calls (auto-build, synth, generate-proposal) can take
  // 60-120s. Node fetch has no default timeout; some intermediate layers
  // do. Surface fetch failures as JSON errors instead of letting them
  // throw up to Next.js's default HTML error page.
  let res: Response;
  try {
    res = await fetch(target, init);
  } catch (err) {
    return NextResponse.json(
      {
        error: `[v2] Upstream fetch to ${opsPath} failed: ${(err as Error).message}. This is usually a timeout (Railway proxy / Node fetch / autobot-inbox unreachable).`,
      },
      { status: 502 }
    );
  }

  const text = await res.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = {
      error: `[v2] Upstream returned non-JSON (status ${res.status}, content-type ${res.headers.get("content-type") || "(none)"}). First 200 chars: ${text.slice(0, 200)}`,
    };
  }
  return NextResponse.json(payload, { status: res.status });
}

/**
 * Binary-aware proxy. Pipes the ops response body through unchanged with
 * Content-Type / Content-Disposition preserved. Use this for downloads
 * (.md, .docx, etc.) — proxyOps assumes JSON and will mangle binary.
 */
export async function proxyOpsBinary(
  req: NextRequest,
  opsPath: string,
  opts: { method?: string; body?: unknown } = {}
): Promise<Response> {
  const ghToken = await getGitHubToken(req);
  if (!ghToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const binHeaders = await opsHeaders(req);
  if (!binHeaders) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const qs = url.search || "";
  const target = `${OPS_API_URL}${opsPath}${qs}`;

  const init: RequestInit = {
    method: opts.method || "GET",
    headers: binHeaders,
  };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(target, init);
  } catch (err) {
    return NextResponse.json(
      { error: `[v2] Binary upstream fetch to ${opsPath} failed: ${(err as Error).message}.` },
      { status: 502 }
    );
  }

  if (!res.ok) {
    // Try to surface the ops error message as JSON when something goes wrong
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      return NextResponse.json(json, { status: res.status });
    } catch {
      return NextResponse.json(
        { error: `[v2] Upstream binary fetch failed (${res.status}). First 200 chars: ${text.slice(0, 200)}` },
        { status: res.status }
      );
    }
  }

  // Stream binary body through with preserved headers.
  const passthrough = new Headers();
  const ct = res.headers.get("content-type");
  const cd = res.headers.get("content-disposition");
  if (ct) passthrough.set("content-type", ct);
  if (cd) passthrough.set("content-disposition", cd);
  // Forward any X-Generation-* metadata so the client can render cost /
  // cache-hit info on downloads.
  res.headers.forEach((value, key) => {
    if (key.toLowerCase().startsWith("x-generation-")) {
      passthrough.set(key, value);
    }
  });
  passthrough.set("cache-control", "no-store");
  return new Response(res.body, { status: 200, headers: passthrough });
}

// ---------------------------------------------------------------------------
// Per-user board JWT auth surface (PR #238's intent, restored per ADR-019 /
// OPT-148 / STAQPRO-528).
//
// `getOpsAuthHeaders` (13 importers), `getOpsAuth` (2 importers), and
// `proxyOpsAdmin` (0 importers) were stubbed by #250 back onto the legacy
// OPS_API_SECRET + spoofable `x-board-user` path. They now mint a short-lived
// RS256 board JWT from the verified NextAuth session — identity is carried by
// the signature, not a header the backend is forced to trust.
// ---------------------------------------------------------------------------

interface AuthedCaller {
  username: string;
  boardMemberId: string;
}

export async function getOpsAuthHeaders(
  req: NextRequest
): Promise<Record<string, string> | null> {
  const ghToken = await getGitHubToken(req);
  if (!ghToken) return null;
  return opsHeaders(req);
}

export async function getOpsAuth(
  req: NextRequest
): Promise<{ headers: Record<string, string>; caller: AuthedCaller } | null> {
  const ghToken = await getGitHubToken(req);
  if (!ghToken) return null;
  const sessionToken = await getToken({ req });
  const username =
    typeof sessionToken?.username === "string" ? sessionToken.username : "";
  if (!username) return null;
  const boardMemberId =
    typeof sessionToken?.boardMemberId === "string"
      ? sessionToken.boardMemberId
      : username; // fall back to username when board_members.id isn't loaded
  const headers = boardAuthHeadersFromIdentity({ username, boardMemberId });
  if (!headers) return null;
  return {
    headers: { "Content-Type": "application/json", ...headers },
    caller: { username, boardMemberId },
  };
}

// `proxyOpsAdmin` historically aliased `proxyOps`. ADR-019: there is no
// pure-admin caller of this module (0 importers); every board route carries a
// human identity, so both paths mint a board JWT. Kept as an alias so any
// future import resolves to the identity-bearing path, never the shared secret.
export const proxyOpsAdmin = proxyOps;

export const OPS_API_URL_EXPORT = OPS_API_URL;
