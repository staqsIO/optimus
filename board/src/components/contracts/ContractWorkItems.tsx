"use client";

import { useState, useEffect, useCallback } from "react";
import { opsFetch } from "@/lib/ops-api";

interface WorkItem {
  id: string;
  type: string;
  title: string;
  description: string | null;
  status: string;
  assigned_to: string | null;
  priority: number;
  deadline: string | null;
  created_at: string;
  signature_request_id: string | null;
}

interface ContractWorkItemsProps {
  contractId: string;
  refreshKey?: number;
}

const STATUS_COLOR: Record<string, string> = {
  created:     "bg-zinc-700/50 text-zinc-300",
  assigned:    "bg-sky-500/15 text-sky-300 border-sky-500/30",
  in_progress: "bg-amber-500/15 text-amber-200 border-amber-500/30",
  review:      "bg-violet-500/15 text-violet-300 border-violet-500/30",
  completed:   "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  failed:      "bg-red-500/15 text-red-300 border-red-500/30",
  blocked:     "bg-orange-500/15 text-orange-300 border-orange-500/30",
  cancelled:   "bg-zinc-700/40 text-zinc-500",
  timed_out:   "bg-zinc-700/40 text-zinc-500",
};

/**
 * Surfaces agent_graph.work_items spawned from this contract. Self-hides
 * when there are none — for signed contracts, extraction can take a few
 * seconds after completion so the component polls once if the contract
 * is signed but the list is empty.
 */
export default function ContractWorkItems({ contractId, refreshKey = 0 }: ContractWorkItemsProps) {
  const [items, setItems] = useState<WorkItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [pollAttempts, setPollAttempts] = useState(0);

  const load = useCallback(async () => {
    if (!contractId) return;
    setLoading(true);
    try {
      const data = await opsFetch<{ work_items: WorkItem[] }>(`/api/contracts/${contractId}/work-items`);
      setItems(data?.work_items || []);
    } finally {
      setLoading(false);
    }
  }, [contractId]);

  useEffect(() => {
    load();
    setPollAttempts(0);
  }, [load, refreshKey]);

  // Retry twice with a delay if we come up empty — commitment extraction
  // takes a few seconds and the user might land on the signed contract
  // before the LLM finishes. Stop after 2 retries (12s total) to avoid
  // polling forever on contracts that legitimately produced zero items.
  useEffect(() => {
    if (items.length > 0 || pollAttempts >= 2 || loading) return;
    const t = setTimeout(() => {
      setPollAttempts((n) => n + 1);
      load();
    }, 6000);
    return () => clearTimeout(t);
  }, [items.length, pollAttempts, loading, load]);

  if (items.length === 0) return null;

  return (
    <div className="border-b border-zinc-800 bg-emerald-500/[0.03]">
      <div className="px-4 py-3">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold text-emerald-200 flex items-center gap-2">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
            </svg>
            Spawned work items
            <span className="px-1.5 py-0.5 text-[9px] font-semibold rounded bg-emerald-500/20 text-emerald-200">
              {items.length}
            </span>
          </h3>
          <span className="text-[10px] text-zinc-500">
            Extracted from the signed contract
          </span>
        </div>

        <ul className="space-y-1.5">
          {items.map((w) => {
            const badgeClass = STATUS_COLOR[w.status] || STATUS_COLOR.created;
            return (
              <li
                key={w.id}
                className="rounded border border-zinc-800 bg-zinc-950/60 px-3 py-2"
              >
                <div className="flex items-start gap-2 mb-1">
                  <span className={`px-1.5 py-0.5 text-[9px] font-medium rounded border ${badgeClass}`}>
                    {w.status}
                  </span>
                  <span className="text-[11px] text-zinc-200 font-medium flex-1">{w.title}</span>
                  {w.deadline && (
                    <span className="text-[9px] text-amber-300 shrink-0">
                      due {new Date(w.deadline).toLocaleDateString()}
                    </span>
                  )}
                </div>
                {w.description && (
                  <p className="text-[10px] text-zinc-400 leading-snug ml-0 mb-1">{w.description}</p>
                )}
                <div className="flex items-center gap-2 text-[9px] text-zinc-600">
                  <span className="font-mono">{w.id.slice(0, 8)}</span>
                  <span>·</span>
                  <span>priority {w.priority}</span>
                  {w.assigned_to && (<><span>·</span><span>→ {w.assigned_to}</span></>)}
                  {!w.assigned_to && <span className="text-zinc-700">unassigned</span>}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
