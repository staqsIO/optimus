"use client";

/**
 * Thin client boundary wrapper for /graph page.
 * Passes server-read search params down into KnowledgeGraph (also "use client").
 */

import KnowledgeGraph from "@/components/graph/KnowledgeGraph";

interface Props {
  initialEntityId?: string;
  initialSince?: "7d" | "30d";
}

export default function KnowledgeGraphClient({
  initialEntityId,
  initialSince,
}: Props) {
  return (
    <KnowledgeGraph
      initialEntityId={initialEntityId}
      initialSince={initialSince}
    />
  );
}
