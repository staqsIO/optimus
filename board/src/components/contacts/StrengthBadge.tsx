"use client";

import { useEffect, useState } from "react";
import { opsFetch } from "@/lib/ops-api";

interface StrengthResponse {
  contactId: string;
  score: number;
  breakdown: {
    tier: string;
    tierBase: number;
    vipBonus: number;
    threadBonus: number;
    docBonus: number;
    projectBonus: number;
    recency: number;
    lastAt: string | null;
    edges: {
      threadCount: number;
      docCount: number;
      projectCount: number;
    } | null;
  };
}

function bandColor(score: number): string {
  if (score >= 70) return "text-emerald-300 border-emerald-400/30 bg-emerald-500/10";
  if (score >= 40) return "text-blue-300 border-blue-400/30 bg-blue-500/10";
  if (score >= 20) return "text-zinc-300 border-white/10 bg-white/[0.02]";
  return "text-zinc-500 border-white/10 bg-white/[0.02]";
}

export default function StrengthBadge({ contactId }: { contactId: string }) {
  const [data, setData] = useState<StrengthResponse | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const resp = await opsFetch<StrengthResponse>(
        `/api/contacts/${contactId}/strength`,
      );
      if (!cancelled && resp) setData(resp);
    })();
    return () => {
      cancelled = true;
    };
  }, [contactId]);

  if (!data) {
    return (
      <span className="text-[10px] text-zinc-600 px-2 py-0.5 rounded border border-white/10">
        strength —
      </span>
    );
  }

  return (
    <div className="inline-block">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`text-xs px-2 py-0.5 rounded border ${bandColor(data.score)}`}
        title="Click for breakdown"
      >
        strength {data.score}
      </button>
      {open && (
        <div className="absolute z-10 mt-1 p-3 rounded border border-white/10 bg-zinc-950 text-xs text-zinc-300 shadow-lg w-64">
          <div className="space-y-1 font-mono">
            <div className="flex justify-between">
              <span>tier {data.breakdown.tier}</span>
              <span>+{data.breakdown.tierBase}</span>
            </div>
            {data.breakdown.vipBonus > 0 && (
              <div className="flex justify-between">
                <span>vip</span>
                <span>+{data.breakdown.vipBonus}</span>
              </div>
            )}
            {data.breakdown.threadBonus > 0 && (
              <div className="flex justify-between">
                <span>
                  threads (
                  {data.breakdown.edges?.threadCount ?? 0})
                </span>
                <span>+{data.breakdown.threadBonus}</span>
              </div>
            )}
            {data.breakdown.docBonus > 0 && (
              <div className="flex justify-between">
                <span>
                  meetings ({data.breakdown.edges?.docCount ?? 0})
                </span>
                <span>+{data.breakdown.docBonus}</span>
              </div>
            )}
            {data.breakdown.projectBonus > 0 && (
              <div className="flex justify-between">
                <span>
                  projects ({data.breakdown.edges?.projectCount ?? 0})
                </span>
                <span>+{data.breakdown.projectBonus}</span>
              </div>
            )}
            {data.breakdown.recency > 0 && (
              <div className="flex justify-between">
                <span>recency</span>
                <span>+{data.breakdown.recency}</span>
              </div>
            )}
            <div className="border-t border-white/10 pt-1 mt-1 flex justify-between font-semibold">
              <span>total</span>
              <span>{data.score}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
