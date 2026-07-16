import { NextRequest } from "next/server";
import { proxyOps } from "@/lib/ops-proxy";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();
  return proxyOps(
    req,
    `/api/engagements/${encodeURIComponent(id)}/section-proposals/bulk`,
    { method: "POST", body }
  );
}
