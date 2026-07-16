import { NextRequest } from "next/server";
import { proxyOps, proxyOpsBinary } from "@/lib/ops-proxy";
import { getSession } from "@/lib/auth";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let body: { format?: string; user_email?: string } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const format = (body.format || "md").toLowerCase();

  // md/docx return binary; gdoc returns JSON. All three need the format
  // forwarded so the ops API knows which converter to invoke.
  if (format === "md" || format === "docx") {
    return proxyOpsBinary(
      req,
      `/api/engagements/${encodeURIComponent(id)}/generate-proposal`,
      { method: "POST", body: { format } }
    );
  }

  // gdoc — derive the impersonation target server-side from the session
  // (never trust a client-supplied user_email). The resulting Google Doc
  // lands in *this* user's Drive via service-account DWD.
  const session = await getSession();
  const userEmail = session?.user?.email || undefined;
  return proxyOps(
    req,
    `/api/engagements/${encodeURIComponent(id)}/generate-proposal`,
    { method: "POST", body: { format: "gdoc", user_email: userEmail } }
  );
}
