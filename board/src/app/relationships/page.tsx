"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { opsFetch } from "@/lib/ops-api";

interface DecayingRow {
  id: string;
  name: string | null;
  email_address: string | null;
  tier: string | null;
  is_vip: boolean;
  organization_id: string | null;
  organization_name: string | null;
  last_received_at: string | null;
  last_sent_at: string | null;
  days_silent: number;
}

const STALENESS_OPTIONS = [
  { days: 7, label: "1 week" },
  { days: 14, label: "2 weeks" },
  { days: 30, label: "1 month" },
  { days: 90, label: "3 months" },
];

export default function RelationshipsPage() {
  const [rows, setRows] = useState<DecayingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [staleAfterDays, setStaleAfterDays] = useState(14);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const resp = await opsFetch<{ decaying: DecayingRow[] }>(
        `/api/relationship-health?staleAfterDays=${staleAfterDays}&limit=20`,
      );
      if (!cancelled) {
        setRows(resp?.decaying || []);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [staleAfterDays]);

  return (
    <div className="px-6 py-8 max-w-4xl">
      <div className="mb-6">
        <h1 className="text-xl font-light text-zinc-100 mb-1">Relationship health</h1>
        <p className="text-xs text-zinc-500">
          Inner-circle and active contacts you haven&apos;t heard from in a while.
          Computed from <span className="font-mono">last_received_at</span> and{" "}
          <span className="font-mono">last_sent_at</span>; service / newsletter /
          automated contacts excluded.
        </p>
      </div>

      <div className="flex items-center gap-2 mb-6">
        <span className="text-xs text-zinc-500">silent for at least</span>
        {STALENESS_OPTIONS.map((opt) => (
          <button
            key={opt.days}
            onClick={() => setStaleAfterDays(opt.days)}
            className={`text-xs px-2 py-1 rounded border ${
              staleAfterDays === opt.days
                ? "border-violet-400/30 bg-violet-500/10 text-violet-300"
                : "border-white/10 bg-white/[0.02] text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-sm text-zinc-500">Loading…</div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-emerald-400">
          ✓ No decaying relationships. Everyone in your inner circle has been touched
          in the last {staleAfterDays} days.
        </p>
      ) : (
        <ul className="divide-y divide-white/5 border border-white/10 rounded-lg overflow-hidden">
          {rows.map((r) => (
            <li
              key={r.id}
              className="bg-white/[0.02] hover:bg-white/[0.04]"
            >
              <Link
                href={`/contacts/${r.id}`}
                className="block px-4 py-3 flex items-center justify-between"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-zinc-100 truncate">
                      {r.name || r.email_address}
                    </span>
                    {r.is_vip && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded border border-amber-400/30 bg-amber-500/10 text-amber-300">
                        VIP
                      </span>
                    )}
                    {r.tier && r.tier !== "unknown" && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded border border-white/10 text-zinc-400">
                        {r.tier.replace("_", " ")}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-zinc-500 truncate">
                    {r.email_address}
                    {r.organization_name && (
                      <>
                        {" · "}
                        <span>{r.organization_name}</span>
                      </>
                    )}
                  </div>
                </div>
                <div className="text-xs text-rose-300 ml-3 whitespace-nowrap font-mono">
                  {r.days_silent}d silent
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
