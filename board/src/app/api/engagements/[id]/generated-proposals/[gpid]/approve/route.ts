import { NextRequest } from "next/server";
import { proxyOps } from "@/lib/ops-proxy";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; gpid: string }> }
) {
  const { id, gpid } = await params;
  return proxyOps(
    req,
    `/api/engagements/${encodeURIComponent(id)}/generated-proposals/${encodeURIComponent(gpid)}/approve`,
    { method: "POST" }
  );
}
