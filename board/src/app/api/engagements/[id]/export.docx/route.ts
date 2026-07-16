import { NextRequest } from "next/server";
import { proxyOpsBinary } from "@/lib/ops-proxy";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  return proxyOpsBinary(req, `/api/engagements/${encodeURIComponent(id)}/export.docx`);
}
