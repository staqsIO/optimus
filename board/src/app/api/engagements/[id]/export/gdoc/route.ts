import { NextRequest } from "next/server";
import { proxyOps } from "@/lib/ops-proxy";
import { getSession } from "@/lib/auth";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  // Always derive the impersonation target server-side from the NextAuth
  // session, never trust a client-supplied user_email — domain-wide
  // delegation contains the blast radius (only emails in the SA's authorized
  // domains succeed), but we still pin to the signed-in identity for
  // attribution + defense in depth. The doc lands in *this* user's Drive.
  const session = await getSession();
  const email = session?.user?.email;
  if (email) {
    body.user_email = email;
  } else {
    // Strip any client-provided value so the backend's "no email resolvable"
    // error fires instead of letting a stray value through.
    delete body.user_email;
  }

  return proxyOps(
    req,
    `/api/engagements/${encodeURIComponent(id)}/export/gdoc`,
    { method: "POST", body }
  );
}
