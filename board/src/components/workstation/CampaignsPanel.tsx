"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { opsFetch } from "@/lib/ops-api";
import { markdownToHtml } from "@/lib/markdown";

interface Campaign {
  id: string;
  goal_description: string;
  campaign_status: string;
  campaign_mode: string;
  budget_envelope_usd: string;
  spent_usd: string;
  max_iterations: number;
  completed_iterations: number;
  total_iterations: string;
  best_score: string | null;
  created_at: string;
}

const STATUS_COLORS: Record<string, string> = {
  pending_approval: "bg-yellow-500/20 text-yellow-300",
  approved: "bg-blue-500/20 text-blue-300",
  running: "bg-emerald-500/20 text-emerald-300",
  paused: "bg-zinc-500/20 text-zinc-300",
  plateau_paused: "bg-orange-500/20 text-orange-300",
};

const ACTIVE_STATUSES = new Set(["pending_approval", "approved", "running", "paused", "plateau_paused"]);

export default function CampaignsPanel() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const data = await opsFetch<{ campaigns: Campaign[] }>("/api/campaigns");
    const active = (data?.campaigns || []).filter((c) => ACTIVE_STATUSES.has(c.campaign_status));
    setCampaigns(active);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  if (loading) {
    return (
      <div className="bg-zinc-900 border border-white/5 rounded-lg p-4">
        <div className="text-xs text-zinc-500">Loading campaigns...</div>
      </div>
    );
  }

  return (
    <div className="bg-zinc-900 border border-white/5 rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between">
        <h3 className="text-sm font-medium text-zinc-300">Active Campaigns</h3>
        <Link href="/campaigns" className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
          View all
        </Link>
      </div>
      {campaigns.length === 0 ? (
        <div className="p-6 text-center">
          <p className="text-xs text-zinc-500 mb-2">No active campaigns</p>
          <Link href="/campaigns" className="text-xs text-emerald-400 hover:text-emerald-300 transition-colors">
            Create a campaign
          </Link>
        </div>
      ) : (
        <div className="divide-y divide-white/5">
          {campaigns.map((c) => {
            const spent = parseFloat(c.spent_usd);
            const total = parseFloat(c.budget_envelope_usd);
            const pct = total > 0 ? Math.min((spent / total) * 100, 100) : 0;
            const barColor = pct > 80 ? "bg-red-500" : pct > 50 ? "bg-yellow-500" : "bg-emerald-500";

            return (
              <Link
                key={c.id}
                href={`/campaigns/${c.id}`}
                className="block px-4 py-3 hover:bg-white/[0.02] transition-colors"
              >
                <div className="flex items-center gap-2 mb-1.5">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${STATUS_COLORS[c.campaign_status] || "bg-zinc-700 text-zinc-300"}`}>
                    {c.campaign_status.replace(/_/g, " ")}
                  </span>
                  {c.campaign_mode && c.campaign_mode !== "stateless" && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-violet-500/20 text-violet-300">
                      {c.campaign_mode}
                    </span>
                  )}
                </div>
                <div
                  className="text-xs text-zinc-300 line-clamp-2 prose prose-sm prose-invert max-w-none [&>*]:m-0 [&>*]:text-xs"
                  dangerouslySetInnerHTML={{ __html: markdownToHtml(c.goal_description) }}
                />
                <div className="flex items-center gap-3 mt-2">
                  <div className="flex-1">
                    <div className="h-1 bg-zinc-800 rounded-full overflow-hidden">
                      <div className={`h-full ${barColor} rounded-full`} style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                  <span className="text-[10px] text-zinc-500">${spent.toFixed(2)}/${total.toFixed(0)}</span>
                  <span className="text-[10px] text-zinc-500">{c.total_iterations}/{c.max_iterations} iter</span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
