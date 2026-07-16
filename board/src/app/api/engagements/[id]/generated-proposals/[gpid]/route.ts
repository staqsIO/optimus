import { NextRequest } from "next/server";
import { proxyOps, proxyOpsBinary } from "@/lib/ops-proxy";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; gpid: string }> }
) {
  const { id, gpid } = await params;
  const url = new URL(req.url);
  const format = url.searchParams.get("format");
  const path = `/api/engagements/${encodeURIComponent(id)}/generated-proposals/${encodeURIComponent(gpid)}`;
  if (format === "md" || format === "docx") {
    // proxyOpsBinary forwards the incoming request's query string automatically.
    return proxyOpsBinary(req, path);
  }
  return proxyOps(req, path, { forwardQuery: true });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; gpid: string }> }
) {
  const { id, gpid } = await params;
  return proxyOps(
    req,
    `/api/engagements/${encodeURIComponent(id)}/generated-proposals/${encodeURIComponent(gpid)}`,
    { method: "DELETE" }
  );
}
