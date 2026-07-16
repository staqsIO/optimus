import { getServerSession } from "next-auth";
import { getToken } from "next-auth/jwt";
import type { NextRequest } from "next/server";
import { authOptions } from "@/lib/next-auth-options";

export async function getSession() {
  return getServerSession(authOptions);
}

export async function getGitHubToken(req: NextRequest): Promise<string | null> {
  const token = await getToken({ req });
  return (token?.accessToken as string) ?? null;
}

export async function getUsername(req: NextRequest): Promise<string | null> {
  const token = await getToken({ req });
  return (token?.username as string) ?? null;
}
