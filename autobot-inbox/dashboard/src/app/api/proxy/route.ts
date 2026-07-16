import { NextRequest, NextResponse } from "next/server";

const API_URL = process.env.API_URL || "http://localhost:3001";
const API_SECRET = process.env.API_SECRET || "";

// Exact-match paths
const ALLOWED_PATHS = [
  "/api/gates",
  "/api/gates/readiness",
  "/api/gates/measure",
  "/api/phase/current",
  "/api/phase/dead-man-switch",
  "/api/phase/dead-man-switch/renew",
  "/api/phase/exploration",
  "/api/phase/activate",
  "/api/system/halt",
  "/api/system/resume",
  "/api/stats",
  "/api/status",
  "/api/accounts",
  "/api/emails/archive",
  "/api/emails/unarchive",
  "/api/voice/bootstrap",
  "/api/voice/rebuild",
];

// Prefix-match paths (dynamic segments like /api/contacts/:id)
const ALLOWED_PREFIXES = [
  "/api/contacts/",
  "/api/accounts/",
  "/api/drive/",
];

function isPathAllowed(path: string): boolean {
  if (ALLOWED_PATHS.includes(path)) return true;
  return ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Generic GET proxy — forwards authenticated GET requests to the backend.
 * Client sends ?path=/api/... and this route adds the Authorization header.
 * Used for GET endpoints that require auth (e.g., audit tier runs).
 */
export async function GET(req: NextRequest) {
  if (!API_SECRET) {
    return NextResponse.json({ error: "API_SECRET not configured" }, { status: 500 });
  }

  try {
    const path = req.nextUrl.searchParams.get("path");
    if (!path || !isPathAllowed(path)) {
      return NextResponse.json({ error: "Path not allowed" }, { status: 403 });
    }

    const res = await fetch(`${API_URL}${path}`, {
      headers: { Authorization: `Bearer ${API_SECRET}` },
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
 * Generic POST proxy — forwards any POST to the backend with Bearer auth.
 * The client sends { path, body } and this route adds the Authorization header
 * server-side so the secret never reaches the browser.
 */
export async function POST(req: NextRequest) {
  if (!API_SECRET) {
    return NextResponse.json({ error: "API_SECRET not configured" }, { status: 500 });
  }

  try {
    const { path, body, method: methodOverride } = await req.json();
    if (!path || typeof path !== "string" || !isPathAllowed(path)) {
      return NextResponse.json({ error: "Path not allowed" }, { status: 403 });
    }

    const httpMethod = (methodOverride === "GET" ? "GET" : "POST");
    const headers: Record<string, string> = {
      Authorization: `Bearer ${API_SECRET}`,
    };
    if (httpMethod === "POST") {
      headers["Content-Type"] = "application/json";
    }

    const res = await fetch(`${API_URL}${path}`, {
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
