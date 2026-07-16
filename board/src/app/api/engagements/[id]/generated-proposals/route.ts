import { NextRequest } from "next/server";
import { proxyOps } from "@/lib/ops-proxy";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  return proxyOps(req, `/api/engagements/${encodeURIComponent(id)}/generated-proposals`);
}
