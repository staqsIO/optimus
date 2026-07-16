import { NextRequest } from "next/server";
import { proxyOps } from "@/lib/ops-proxy";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; sid: string }> }
) {
  const { id, sid } = await params;
  const body = await req.json();
  return proxyOps(
    req,
    `/api/engagements/${encodeURIComponent(id)}/sections/${encodeURIComponent(sid)}/reorder`,
    { method: "POST", body }
  );
}
