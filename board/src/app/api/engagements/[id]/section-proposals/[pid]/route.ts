import { NextRequest } from "next/server";
import { proxyOps } from "@/lib/ops-proxy";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; pid: string }> }
) {
  const { id, pid } = await params;
  const body = await req.json();
  return proxyOps(
    req,
    `/api/engagements/${encodeURIComponent(id)}/section-proposals/${encodeURIComponent(pid)}`,
    { method: "POST", body }
  );
}
