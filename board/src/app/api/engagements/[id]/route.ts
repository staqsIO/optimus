import { NextRequest } from "next/server";
import { proxyOps } from "@/lib/ops-proxy";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  return proxyOps(req, `/api/engagements/${encodeURIComponent(id)}`);
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();
  return proxyOps(req, `/api/engagements/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body,
  });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  return proxyOps(req, `/api/engagements/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}
