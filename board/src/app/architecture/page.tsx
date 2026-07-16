import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/next-auth-options";

export const metadata = { title: "Architecture — Optimus Board" };

/**
 * OPT-88 / feature-001 — Architecture page.
 *
 * Embeds the vendored Understand-Anything dashboard (public/architecture-app/, a
 * static Vite SPA) as an iframe. The SPA fetches its graph from the auth-gated
 * /api/architecture/graph route same-origin. The page itself is gated by the
 * global next-auth middleware; the explicit session check here is P1
 * defense-in-depth.
 *
 * This is the *code* architecture graph (layers, files, functions, guided tour)
 * — distinct from the operational /graph view (agent topology + signals).
 */
export default async function ArchitecturePage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/api/auth/signin");

  return (
    <div className="w-full h-full">
      {/* sandboxed: the SPA is vendored third-party build output. allow-same-origin
          is required so it can fetch /api/architecture/graph with the session cookie. */}
      <iframe
        src="/architecture-app/index.html"
        title="Optimus code architecture graph"
        className="w-full h-full border-0"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      />
    </div>
  );
}
