import { NextRequest } from "next/server";
import { proxyOps } from "@/lib/ops-proxy";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; cid: string }> }
) {
  const { id, cid } = await params;
  const body = await req.json();
  return proxyOps(
    req,
    `/api/engagements/${encodeURIComponent(id)}/conflicts/${encodeURIComponent(cid)}/resolve`,
    { method: "POST", body }
  );
}
