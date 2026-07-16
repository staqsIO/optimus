"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { opsFetch } from "@/lib/ops-api";
import {
  formatConfidence,
  type ArtifactLink,
  type ArtifactFact,
  type EnrichResponse,
} from "@/lib/artifacts";

/**
 * Per-entity "Artifacts" section (OPT-94 PR B, item 4).
 *
 * Renders linked artifacts + derived facts for a contact or project by calling
 * GET /api/artifacts/enrich/{entityType}/:id. The enrich endpoint only supports
 * `contact` and `project` (no engagement/org route exists) — callers must pass
 * one of those two.
 */
export default function EntityArtifactsSection({
  entityType,
  entityId,
}: {
  entityType: "contact" | "project";
  entityId: string;
}) {
  const [links, setLinks] = useState<ArtifactLink[]>([]);
  const [facts, setFacts] = useState<ArtifactFact[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const data = await opsFetch<EnrichResponse>(
      `/api/artifacts/enrich/${entityType}/${entityId}`,
    );
    if (data) {
      setLinks(data.links || []);
      setFacts(data.facts || []);
    }
    setLoading(false);
  }, [entityType, entityId]);

  useEffect(() => {
    load();
  }, [load]);

  // Map artifact_id → human label so facts can cite their source artifact.
  const labelFor = (artifactId: string): string => {
    const link = links.find((l) => l.artifact_id === artifactId);
    return link ? `${link.entity_type} link` : artifactId.slice(0, 8);
  };

  return (
    <div className="bg-zinc-900 border border-white/5 rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between">
        <h3 className="text-sm font-medium text-zinc-300">Artifacts</h3>
        <button
          onClick={load}
          className="px-2.5 py-1 text-xs rounded text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors border border-white/10"
        >
          refresh
        </button>
      </div>

      <div className="p-4 space-y-5">
        {loading ? (
          <p className="text-xs text-zinc-500">Loading artifacts…</p>
        ) : (
          <>
            {/* Linked artifacts */}
            <section>
              <h4 className="text-[11px] font-semibold text-zinc-500 uppercase tracking-widest mb-2">
                Linked Artifacts ({links.length})
              </h4>
              {links.length === 0 ? (
                <p className="text-xs text-zinc-500">No artifacts linked to this {entityType}.</p>
              ) : (
                <ul className="space-y-1.5">
                  {links.map((link) => (
                    <li key={link.id} className="flex items-center gap-3 text-sm">
                      <Link
                        href={`/artifacts?artifact=${link.artifact_id}`}
                        className="text-cyan-400 hover:text-cyan-300 transition-colors font-mono text-xs"
                      >
                        {link.artifact_id.slice(0, 8)}
                      </Link>
                      <LinkStatusBadge status={link.link_status} />
                      <span className="text-zinc-500 text-xs ml-auto">
                        {formatConfidence(link.confidence)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Derived facts */}
            <section>
              <h4 className="text-[11px] font-semibold text-zinc-500 uppercase tracking-widest mb-2">
                Derived Facts ({facts.length})
              </h4>
              {facts.length === 0 ? (
                <p className="text-xs text-zinc-500">No facts derived yet.</p>
              ) : (
                <ul className="space-y-2">
                  {facts.map((fact) => (
                    <li key={fact.id} className="text-sm text-zinc-200">
                      <p>{fact.fact}</p>
                      <p className="text-[11px] text-zinc-500 mt-0.5">
                        from{" "}
                        <Link
                          href={`/artifacts?artifact=${fact.artifact_id}`}
                          className="text-cyan-400 hover:text-cyan-300 transition-colors"
                        >
                          {labelFor(fact.artifact_id)}
                        </Link>{" "}
                        · {formatConfidence(fact.confidence)} confidence
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

const STATUS_BADGE: Record<string, string> = {
  auto: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
  pending: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  confirmed: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  rejected: "bg-red-500/20 text-red-400 border-red-500/30",
};

function LinkStatusBadge({ status }: { status: string }) {
  const cls = STATUS_BADGE[status] ?? STATUS_BADGE.auto;
  return (
    <span className={`inline-flex px-1.5 py-0.5 text-[10px] font-mono rounded border ${cls}`}>
      {status}
    </span>
  );
}
