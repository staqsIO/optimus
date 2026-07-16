"use client";

import { useState, useEffect } from "react";
import { opsFetch } from "@/lib/ops-api";
import Link from "next/link";

interface Campaign {
  id: string;
  goal_description: string;
  campaign_status: string;
  campaign_mode: string;
  spent_usd: string;
  completed_iterations: number;
  max_iterations: number;
  created_at: string;
}

const STATUS_COLORS: Record<string, string> = {
  running: "bg-blue-400",
  approved: "bg-amber-400",
  completed: "bg-emerald-400",
  failed: "bg-red-400",
  cancelled: "bg-zinc-500",
  awaiting_input: "bg-purple-400",
};

export default function CampaignsWidget() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);

  useEffect(() => {
    opsFetch<{ campaigns: Campaign[] }>("/api/campaigns?limit=6&status=running,approved,awaiting_input,failed")
      .then((data) => setCampaigns(data?.campaigns || []))
      .catch(() => {});
    const t = setInterval(() => {
      opsFetch<{ campaigns: Campaign[] }>("/api/campaigns?limit=6&status=running,approved,awaiting_input,failed")
        .then((data) => setCampaigns(data?.campaigns || []))
        .catch(() => {});
    }, 30_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="bg-surface-raised rounded-lg border border-white/5 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-zinc-300">Active Campaigns</h3>
        <Link href="/campaigns" className="text-[10px] text-zinc-500 hover:text-zinc-300">View all</Link>
      </div>
      {campaigns.length === 0 ? (
        <div className="text-xs text-zinc-600">No active campaigns</div>
      ) : (
        <div className="space-y-2">
          {campaigns.map((c) => (
            <Link key={c.id} href={`/campaigns/${c.id}`} className="block">
              <div className="flex items-center gap-2 text-xs group">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_COLORS[c.campaign_status] || "bg-zinc-500"}`} />
                <span className="text-zinc-300 truncate flex-1 group-hover:text-zinc-100">{c.goal_description?.slice(0, 60)}</span>
                <span className="text-zinc-600 text-[10px] shrink-0">{c.campaign_status}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
