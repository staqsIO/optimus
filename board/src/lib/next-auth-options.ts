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
        const gh = profile as { login?: string; avatar_url?: string; email?: string | null };
        token.username = gh.login;
        token.avatar = gh.avatar_url;
        // STAQPRO-550: carry the viewer email so /today can match the operator
        // against meeting-attendee rosters. GitHub omits the primary email for
        // accounts with a private email (profile.email === null); in that case we
        // backfill below from the canonical board_members work email.
        token.email = gh.email ?? null;

        // Fetch role from board_members table (P1: deny by default — unknown users get 'member')
        try {
          const apiUrl = process.env.NEXT_PUBLIC_OPS_API_URL || process.env.OPS_API_URL;
          if (apiUrl && gh.login) {
            const res = await fetch(`${apiUrl}/api/board-member?username=${gh.login}`);
            if (res.ok) {
              const data = await res.json();
              if (data.id) {
                token.role = data.role || "member";
                token.boardMemberId = data.id;
                token.displayName = data.display_name;
                // Prefer GitHub's primary email; fall back to the canonical work
                // email from board_members when GitHub withheld it (private email).
                if (!token.email && data.email) token.email = data.email;
              }
            }
          }
        } catch {
          // Deny by default — role stays undefined, defaulting to 'member' in session
        }
        if (!token.role) token.role = "member";
      }
      return token;
    },
    async session({ session, token }) {
      // Expose username, avatar, and role to client — NOT the access token
      session.user = {
        ...session.user,
        name: token.username as string,
        // STAQPRO-550: surface the viewer email to the client so useCurrentUser()
        // (and /today meeting-attendee matching) can key on it.
        email: (token.email as string | null) ?? null,
        // STAQPRO-531: expose GitHub login under an unambiguous `username` field so the
        // inbox-proxy can forward viewer identity via x-board-user. `name` is overloaded
        // (display name) and must not be relied on for owner-scoping.
        username: token.username as string | undefined,
        image: token.avatar as string,
        role: token.role as string,
        boardMemberId: token.boardMemberId as string,
        displayName: token.displayName as string,
      };
      return session;
    },
  },
  pages: {
    error: "/",
  },
};
