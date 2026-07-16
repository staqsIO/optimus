import { NextRequest } from "next/server";
import { proxyOps } from "@/lib/ops-proxy";

export async function POST(req: NextRequest) {
  const body = await req.json();
  return proxyOps(req, "/api/engagements/client-search", {
    method: "POST",
    body,
  });
}
