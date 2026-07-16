import { Suspense } from "react";
import KnowledgeGraphClient from "./KnowledgeGraphClient";

export const metadata = {
  title: "Knowledge Graph — Optimus Board",
  description: "Explore entity relationships across contacts, organizations, and topics",
};

/**
 * /graph — Knowledge Graph Tier 1 entity-lens view (OPT-80)
 *
 * Server component wrapper that reads `?entity=` and `?since=` URL search
 * params and passes them as initial props to the client graph component.
 * URL state is owned by the client (router.replace) after mount.
 */
interface GraphPageProps {
  searchParams: Promise<{ entity?: string; since?: string }>;
}

export default async function GraphPage({ searchParams }: GraphPageProps) {
  const params = await searchParams;
  const initialEntityId = params.entity;
  const rawSince = params.since;
  const initialSince =
    rawSince === "7d" || rawSince === "30d" ? rawSince : "30d";

  return (
    <div className="w-full h-full">
      <Suspense
        fallback={
          <div className="flex items-center justify-center h-full">
            <span className="text-sm text-zinc-500 animate-pulse">
              Loading Knowledge Graph…
            </span>
          </div>
        }
      >
        <KnowledgeGraphClient
          initialEntityId={initialEntityId}
          initialSince={initialSince}
        />
      </Suspense>
    </div>
  );
}
