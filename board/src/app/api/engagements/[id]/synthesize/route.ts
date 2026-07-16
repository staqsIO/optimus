import { NextRequest } from "next/server";
import { proxyOps } from "@/lib/ops-proxy";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  return proxyOps(
    req,
    `/api/engagements/${encodeURIComponent(id)}/synthesize`,
    { method: "POST", body }
  );
}
