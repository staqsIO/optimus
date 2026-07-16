"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import { opsFetch, opsPost } from "@/lib/ops-api";
import { useEventStream } from "@/hooks/useEventStream";
import { usePageContext } from "@/contexts/PageContext";
import { useToast } from "@/components/Toast";

interface Campaign {
  id: string;
  work_item_id: string;
  goal_description: string;
  campaign_status: string;
  campaign_mode: string;
  budget_envelope_usd: string;
  spent_usd: string;
  reserved_usd: string;
  max_iterations: number;
  completed_iterations: number;
  total_iterations: string;
  best_score: string | null;
  work_item_title: string;
  created_by: string;
  created_at: string;
  completed_at: string | null;
  updated_at: string;
  metadata?: Record<string, unknown>;
}

interface ExplorerDomain {
  domain: string;
  enabled: boolean;
  priority: number;
  runs_7d: string;
  findings_7d: string;
  // STAQPRO-553: last time this domain actually ran. null = never scheduled/run,
  // which (with the scheduler now wired) distinguishes "dead scheduler" from
  // "enabled but not yet due".
  last_run_at: string | null;
}

interface ExplorerStatus {
  cycles: Array<{
    cycle_id: string;
    domain: string;
    findings_count: number;
    cost_usd: string;
    duration_ms: number;
    error: string | null;
    created_at: string;
  }>;
  domains: ExplorerDomain[];
  today_spend: number;
}

const STATUS_COLORS: Record<string, string> = {
  pending_approval: "bg-yellow-500/20 text-yellow-300",
  approved: "bg-blue-500/20 text-blue-300",
  running: "bg-emerald-500/20 text-emerald-300",
  paused: "bg-zinc-500/20 text-zinc-300",
  plateau_paused: "bg-orange-500/20 text-orange-300",
  awaiting_input: "bg-violet-500/20 text-violet-300",
  succeeded: "bg-green-500/20 text-green-300",
  failed: "bg-red-500/20 text-red-300",
  cancelled: "bg-zinc-600/20 text-zinc-400",
};

// STAQPRO-553: compact relative time for the Explorer last-run indicator.
function formatLastRun(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "unknown";
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

export default function CampaignsPage() {
  const { setCurrentPage } = usePageContext();
  const toast = useToast();
  useEffect(() => { setCurrentPage({ route: "/campaigns", title: "Runs" }); return () => setCurrentPage(null); }, [setCurrentPage]);

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [explorer, setExplorer] = useState<ExplorerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("active");

  const load = useCallback(async () => {
    const [campData, expData] = await Promise.all([
      opsFetch<{ campaigns: Campaign[] }>("/api/campaigns"),
      opsFetch<ExplorerStatus>("/api/explorer/status"),
    ]);
    setCampaigns(campData?.campaigns || []);
    setExplorer(expData);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Debounced load — prevents SSE event storms from exhausting DB connections
  const loadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedLoad = useCallback(() => {
    if (loadTimeoutRef.current) return; // Already pending
    loadTimeoutRef.current = setTimeout(() => {
      loadTimeoutRef.current = null;
      load();
    }, 1000); // Coalesce events within 1s
  }, [load]);

  // SSE-driven refresh on campaign events
  useEventStream("campaign_approved", debouncedLoad);
  useEventStream("campaign_paused", debouncedLoad);
  useEventStream("campaign_iterated", debouncedLoad);
  useEventStream("campaign_outcome_recorded", debouncedLoad);
  useEventStream("hitl_request", debouncedLoad);

  // Fallback poll at 30s (SSE handles real-time; this is just a safety net)
  useEffect(() => {
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  async function toggleDomain(domain: string) {
    await opsPost(`/api/explorer/domains/${domain}/toggle`);
    load();
  }

  // Filter campaigns by status
  const ACTIVE_STATUSES = new Set(["approved", "running", "awaiting_input", "paused", "plateau_paused", "pending_approval"]);
  const filteredCampaigns = statusFilter === "all"
    ? campaigns
    : statusFilter === "active"
      ? campaigns.filter((c) => ACTIVE_STATUSES.has(c.campaign_status))
      : campaigns.filter((c) => c.campaign_status === statusFilter);

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <div className="text-zinc-500 text-sm">Loading campaigns...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-200 p-6">
      <div className="max-w-7xl mx-auto space-y-8">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">Runs</h1>
          <Link href="/chat" className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm font-medium rounded-lg transition-colors">
            Start from Chat →
          </Link>
        </div>

        {/* Status filter tabs */}
        <div className="flex gap-1">
          {[
            { key: "active", label: "Active", count: campaigns.filter((c) => ACTIVE_STATUSES.has(c.campaign_status)).length },
            { key: "succeeded", label: "Completed", count: campaigns.filter((c) => c.campaign_status === "succeeded").length },
            { key: "failed", label: "Failed", count: campaigns.filter((c) => c.campaign_status === "failed").length },
            { key: "cancelled", label: "Cancelled", count: campaigns.filter((c) => c.campaign_status === "cancelled").length },
            { key: "all", label: "All", count: campaigns.length },
          ].map((tab) => (
            <button
              key={tab.key}
              onClick={() => setStatusFilter(tab.key)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                statusFilter === tab.key
                  ? "bg-zinc-800 text-zinc-200"
                  : "text-zinc-500 hover:text-zinc-400"
              }`}
            >
              {tab.label} ({tab.count})
            </button>
          ))}
        </div>

        {/* Run List */}
        <section>
          {filteredCampaigns.length === 0 ? (
            <div className="bg-zinc-900 border border-white/5 rounded-lg p-8 text-center text-zinc-500 text-sm">
              {statusFilter === "active" ? "Nothing running. Start a task from Chat." : `No ${statusFilter} runs.`}
            </div>
          ) : (
            <div className="bg-zinc-900 border border-white/5 rounded-lg overflow-hidden divide-y divide-white/5">
              {filteredCampaigns.map((c) => (
                <div key={c.id} className="flex items-center gap-3 px-4 py-3 hover:bg-white/[0.02] transition-colors">
                  <Link href={`/campaigns/${c.id}`} className="flex items-center gap-3 flex-1 min-w-0">
                    <span className={`px-2 py-0.5 rounded text-[10px] font-medium shrink-0 w-24 text-center ${STATUS_COLORS[c.campaign_status] || "bg-zinc-700 text-zinc-300"}`}>
                      {c.campaign_status.replace(/_/g, " ")}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-zinc-200 truncate">
                        {c.goal_description.replace(/^#\s+/, "").split("\n")[0].slice(0, 100)}
                      </div>
                    </div>
                    <div className="flex items-center gap-4 text-xs text-zinc-500 shrink-0">
                      <span>{c.total_iterations}/{c.max_iterations}</span>
                      <span>${parseFloat(c.spent_usd).toFixed(2)}</span>
                      <BudgetBar spent={parseFloat(c.spent_usd)} total={parseFloat(c.budget_envelope_usd)} />
                      <span className="w-16 text-right">{new Date(c.created_at).toLocaleDateString()}</span>
                    </div>
                  </Link>
                  {/* Actions: cancel/pause for active campaigns */}
                  {["approved", "running", "awaiting_input", "paused", "plateau_paused"].includes(c.campaign_status) && (
                    <button
                      onClick={async (e) => {
                        e.preventDefault();
                        try {
                          await opsPost(`/api/campaigns/${c.id}/cancel`);
                          toast.success("Campaign cancelled");
                        } catch { toast.error("Failed to cancel"); }
                        load();
                      }}
                      className="px-2 py-1 text-[10px] rounded bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20 transition-colors shrink-0"
                      title="Cancel campaign"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Explorer Status */}
        {explorer && (
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-medium text-zinc-300">Explorer</h2>
              <span className="text-xs text-zinc-500">Today: ${explorer.today_spend.toFixed(2)}</span>
            </div>

            {/* Domain Grid */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
              {explorer.domains.map((d) => (
                <div
                  key={d.domain}
                  className={`bg-zinc-900 border rounded-lg p-3 ${d.enabled ? "border-white/10" : "border-white/5 opacity-50"}`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium text-zinc-300">{d.domain.replace(/_/g, " ")}</span>
                    <button
                      onClick={(e) => { e.preventDefault(); toggleDomain(d.domain); }}
                      className={`w-8 h-4 rounded-full transition-colors ${d.enabled ? "bg-emerald-600" : "bg-zinc-700"}`}
                    >
                      <div className={`w-3 h-3 rounded-full bg-white transition-transform ${d.enabled ? "translate-x-4" : "translate-x-0.5"}`} />
                    </button>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-zinc-500">
                    <span>P{d.priority}</span>
                    <span>{d.runs_7d} runs/7d</span>
                    <span>{d.findings_7d} findings</span>
                  </div>
                  {/* STAQPRO-553: last-run timestamp distinguishes a dead scheduler
                      (never ran) from "enabled but not yet due". */}
                  <div className="mt-1 text-[10px] text-zinc-600">
                    {d.last_run_at
                      ? `last run ${formatLastRun(d.last_run_at)}`
                      : d.enabled
                        ? "never run — scheduler not firing"
                        : "disabled"}
                  </div>
                </div>
              ))}
            </div>

            {/* Recent Cycles */}
            {explorer.cycles.length > 0 && (
              <div className="bg-zinc-900 border border-white/5 rounded-lg overflow-hidden">
                <div className="px-4 py-2 border-b border-white/5">
                  <span className="text-xs font-medium text-zinc-400">Recent Exploration Cycles</span>
                </div>
                <div className="divide-y divide-white/5 max-h-64 overflow-y-auto">
                  {explorer.cycles.slice(0, 20).map((cycle, i) => (
                    <div key={i} className="px-4 py-2 flex items-center gap-3 text-xs">
                      <span className="text-zinc-500 w-20">{new Date(cycle.created_at).toLocaleTimeString()}</span>
                      <span className="text-zinc-300 w-28">{cycle.domain.replace(/_/g, " ")}</span>
                      <span className={cycle.findings_count > 0 ? "text-yellow-300" : "text-zinc-500"}>
                        {cycle.findings_count} finding(s)
                      </span>
                      <span className="text-zinc-600">{cycle.duration_ms}ms</span>
                      {cycle.error && <span className="text-red-400 truncate">{cycle.error}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

function BudgetBar({ spent, total }: { spent: number; total: number }) {
  const pct = total > 0 ? Math.min((spent / total) * 100, 100) : 0;
  const color = pct > 80 ? "bg-red-500" : pct > 50 ? "bg-yellow-500" : "bg-emerald-500";
  const tooltipText = `Metric: Budget Utilization | Details: $${spent.toFixed(2)} / $${total.toFixed(2)} spent`;
  return (
    <div className="w-20 flex-shrink-0 relative group">
      {/* Tooltip */}
      <div
        role="tooltip"
        className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2.5 py-1.5 bg-zinc-800 border border-white/10 rounded-md text-xs text-zinc-200 whitespace-nowrap pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-200 z-50 shadow-lg"
        aria-label={tooltipText}
      >
        <div className="font-medium text-zinc-100">Budget Utilization</div>
        <div className="text-zinc-400">${spent.toFixed(2)} / ${total.toFixed(2)} &mdash; {pct.toFixed(0)}%</div>
        {/* Arrow */}
        <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-zinc-800" />
      </div>
      <div
        className="h-1.5 bg-zinc-800 rounded-full overflow-hidden cursor-default"
        aria-label={tooltipText}
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <div className="text-xs text-zinc-500 mt-0.5 text-right">{pct.toFixed(0)}%</div>
    </div>
  );
}
