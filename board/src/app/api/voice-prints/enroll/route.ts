import { NextRequest, NextResponse } from "next/server";
import { getOpsAuth } from "@/lib/ops-proxy";

const API_URL = process.env.OPS_API_URL || "http://localhost:3001";
const ENROLL_TIMEOUT_MS = 60_000;

/**
 * Voice-print enrollment binary proxy.
 *
 * The shared /api/ops proxy round-trips JSON only — voice-print enrollment
 * needs to pipe raw audio bytes (browser MediaRecorder webm/opus) through to
 * the backend. This route forwards the request body verbatim and copies the
 * relevant query string (contactId, displayName) onto the backend URL.
 */
export async function POST(req: NextRequest) {
  const auth = await getOpsAuth(req);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const contactId = url.searchParams.get("contactId") || "";
  const displayName = url.searchParams.get("displayName") || "";
  if (!contactId) {
    return NextResponse.json({ error: "contactId required" }, { status: 400 });
  }

  const audio = await req.arrayBuffer();
  if (audio.byteLength === 0) {
    return NextResponse.json({ error: "audio body required" }, { status: 400 });
  }

  const backendUrl = new URL("/api/voice-prints/enroll", API_URL);
  backendUrl.searchParams.set("contactId", contactId);
  if (displayName) backendUrl.searchParams.set("displayName", displayName);

  // getOpsAuth returns Content-Type: application/json by default — for binary
  // upload we override but keep the Authorization Bearer JWT header.
  const headers: Record<string, string> = {
    ...auth.headers,
    "Content-Type":
      req.headers.get("content-type") || "application/octet-stream",
    "X-Board-User": auth.caller.username,
  };

  try {
    const res = await fetch(backendUrl, {
      method: "POST",
      headers,
      body: audio,
      signal: AbortSignal.timeout(ENROLL_TIMEOUT_MS),
    });
    const data = await res
      .json()
      .catch(() => ({ error: "Backend returned non-JSON" }));
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json({ error: "Backend unreachable" }, { status: 502 });
  }
}
