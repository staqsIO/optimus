import { NextRequest } from "next/server";
import { proxyOps } from "@/lib/ops-proxy";

export async function GET(req: NextRequest) {
  return proxyOps(req, "/api/engagements", { forwardQuery: true });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  return proxyOps(req, "/api/engagements", { method: "POST", body });
}
