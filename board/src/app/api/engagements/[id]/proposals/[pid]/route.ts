import { NextRequest } from "next/server";
import { proxyOps } from "@/lib/ops-proxy";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; pid: string }> }
) {
  const { id, pid } = await params;
  return proxyOps(
    req,
    `/api/engagements/${encodeURIComponent(id)}/proposals/${encodeURIComponent(pid)}`,
    { method: "DELETE" }
  );
}
