import type { AuthOptions } from "next-auth";
import GitHubProvider from "next-auth/providers/github";

const ALLOWED_ORG = "staqsIO";

// Explicit board member allowlist — always permitted regardless of org membership.
// Env var is comma-separated: "ecgang,ConsultingFuture4200"
const BOARD_MEMBERS = new Set(
  (process.env.BOARD_MEMBERS || "ecgang,ConsultingFuture4200")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

export const authOptions: AuthOptions = {
  providers: [
    GitHubProvider({
      clientId: process.env.GITHUB_ID!,
      clientSecret: process.env.GITHUB_SECRET!,
      authorization: { params: { scope: "repo read:org" } },
    }),
  ],
  callbacks: {
    async signIn({ account, profile }) {
      if (!account?.access_token || !profile) return false;

      const username = (profile as { login?: string }).login;
      if (!username) return false;

      // Check 1: explicit board member allowlist
      if (BOARD_MEMBERS.has(username.toLowerCase())) return true;

      // Check 2: staqsIO org membership
      try {
        const res = await fetch(
          `https://api.github.com/orgs/${ALLOWED_ORG}/members/${username}`,
          {
            headers: {
              Authorization: `Bearer ${account.access_token}`,
              Accept: "application/vnd.github+json",
            },
          }
        );
        return res.status === 204;
      } catch {
        return false;
      }
    },
    async jwt({ token, account, profile }) {
      // Persist GitHub access token in JWT (server-side only)
      if (account?.access_token) {
        token.accessToken = account.access_token;
      }
      if (profile) {
        const gh = profile as { login?: string; avatar_url?: string };
        token.username = gh.login;
        token.avatar = gh.avatar_url;
      }
      return token;
    },
    async session({ session, token }) {
      // Expose username and avatar to client — NOT the access token
      session.user = {
        ...session.user,
        name: token.username as string,
        image: token.avatar as string,
      };
      return session;
    },
  },
  pages: {
    error: "/",
  },
};
