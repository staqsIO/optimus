"use client";

import { useSession } from "next-auth/react";

export type BoardRole = "admin" | "member" | "external_agent";

export function useCurrentUser() {
  const { data: session, status } = useSession();

  return {
    username: session?.user?.name || "",
    displayName: session?.user?.displayName || session?.user?.name || "",
    email: session?.user?.email || "",
    avatar: session?.user?.image || "",
    role: (session?.user?.role as BoardRole) || "member",
    boardMemberId: session?.user?.boardMemberId || "",
    isAdmin: session?.user?.role === "admin",
    isLoading: status === "loading",
    isAuthenticated: status === "authenticated",
  };
}
