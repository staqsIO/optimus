"use client";

/**
 * Triage Queue — shows issue triage decisions with override capability.
 * Lives as a tab in the Agent Hub.
 */

import { useState, useEffect, useCallback } from "react";
import { opsFetch, opsPost } from "@/lib/ops-api";

interface TriageEntry {
  id: string;
  source: string;
  source_issue_id: string;
  source_issue_url: string;
  title: string;
  clarity_score: number | null;
  feasibility: string | null;
  scope_estimate: string | null;
  classification: string | null;
  target_repos: string[] | null;
  playbook_id: string | null;
  reasoning: string | null;
  decision: string;
  decision_overridden_by: string | null;
  campaign_id: string | null;
  created_at: string;
}

interface TriageStats {
  byDecision: Record<string, { count: number; lastTriaged: string }>;
  total: number;
  last24h: number;
}

const DECISION_COLORS: Record<string, string> = {
  auto_assigned: "bg-emerald-500/20 text-emerald-300",
  needs_clarification: "bg-amber-500/20 text-amber-300",
  board_review: "bg-blue-500/20 text-blue-300",
  skipped: "bg-zinc-700 text-zinc-400",
  pending: "bg-zinc-600 text-zinc-300",
};

const CLARITY_COLORS: Record<number, string> = {
  1: "text-red-400",
  2: "text-red-300",
  3: "text-amber-300",
  4: "text-emerald-300",
  5: "text-emerald-400",
};

const SOURCE_ICONS: Record<string, string> = {
  linear: "◼",
  github: "⬡",
};

export default function TriageQueue() {
  const [entries, setEntries] = useState<TriageEntry[]>([]);
  const [stats, setStats] = useState<TriageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>("all");
  const [overriding, setOverriding] = useState<string | null>(null);

  const load = useCallback(async () => {
    const filterParam = filter !== "all" ? `?decision=${filter}` : "";
    const [entriesData, statsData] = await Promise.all([
      opsFetch<{ entries: TriageEntry[] }>(`/api/triage${filterParam}`),
      opsFetch<TriageStats>("/api/triage/stats"),
    ]);
    setEntries(entriesData?.entries || []);
    setStats(statsData);
    setLoading(false);
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  async function handleOverride(id: string, decision: "auto_assigned" | "skipped") {
    setOverriding(id);
    await opsPost("/api/triage/override", { id, decision });
    setOverriding(null);
    await load();
  }

  if (loading) {
    return <div className="py-8 text-center text-sm text-zinc-500">Loading triage queue...</div>;
  }

  return (
    <div className="p-4 space-y-4 overflow-y-auto h-full">
      {/* Stats bar */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <div className="bg-zinc-900 border border-white/5 rounded-lg p-3">
            <div className="text-xs text-zinc-500 mb-1">Total Triaged</div>
            <div className="text-lg font-bold text-zinc-200">{stats.total}</div>
          </div>
          <div className="bg-zinc-900 border border-white/5 rounded-lg p-3">
            <div className="text-xs text-zinc-500 mb-1">Last 24h</div>
            <div className="text-lg font-bold text-zinc-200">{stats.last24h}</div>
          </div>
          {["auto_assigned", "needs_clarification", "board_review"].map((d) => (
            <div key={d} className="bg-zinc-900 border border-white/5 rounded-lg p-3">
              <div className="text-xs text-zinc-500 mb-1 capitalize">{d.replace(/_/g, " ")}</div>
              <div className="text-lg font-bold text-zinc-200">{stats.byDecision[d]?.count || 0}</div>
            </div>
          ))}
        </div>
      )}

      {/* Filter */}
      <div className="flex gap-1">
        {["all", "auto_assigned", "needs_clarification", "board_review", "skipped"].map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1 text-xs rounded transition-colors capitalize ${
              filter === f
                ? "bg-zinc-700 text-zinc-100"
                : "text-zinc-500 hover:text-zinc-300 hover:bg-white/5"
            }`}
          >
            {f.replace(/_/g, " ")}
          </button>
        ))}
      </div>

      {/* Table */}
      {entries.length === 0 ? (
        <div className="bg-zinc-900 border border-white/5 rounded-lg p-8 text-center text-zinc-500 text-sm">
          {filter === "all" ? "No issues triaged yet. The triage agent polls every 5 minutes." : `No ${filter.replace(/_/g, " ")} entries.`}
        </div>
      ) : (
        <div className="bg-zinc-900 border border-white/5 rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/5 text-zinc-500 text-xs">
                  <th className="text-left p-3">Source</th>
                  <th className="text-left p-3">Title</th>
                  <th className="text-center p-3">Clarity</th>
                  <th className="text-center p-3">Scope</th>
                  <th className="text-left p-3">Decision</th>
                  <th className="text-left p-3">Reasoning</th>
                  <th className="text-left p-3">Time</th>
                  <th className="text-left p-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {entries.map((e) => (
                  <tr key={e.id} className="hover:bg-white/[.02]">
                    <td className="p-3">
                      <span className="text-xs" title={e.source}>
                        {SOURCE_ICONS[e.source] || "?"} {e.source}
                      </span>
                    </td>
                    <td className="p-3 max-w-[300px]">
                      <a
                        href={e.source_issue_url || "#"}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-zinc-200 hover:text-accent-bright truncate block"
                      >
                        {e.title}
                      </a>
                      {e.target_repos?.[0] && (
                        <span className="text-[10px] text-zinc-600 font-mono">{e.target_repos[0]}</span>
                      )}
                    </td>
                    <td className="p-3 text-center">
                      {e.clarity_score !== null ? (
                        <span className={`font-bold ${CLARITY_COLORS[e.clarity_score] || "text-zinc-400"}`}>
                          {e.clarity_score}/5
                        </span>
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                    </td>
                    <td className="p-3 text-center">
                      {e.scope_estimate ? (
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                          e.scope_estimate === "S" ? "bg-emerald-500/10 text-emerald-400" :
                          e.scope_estimate === "M" ? "bg-amber-500/10 text-amber-400" :
                          "bg-red-500/10 text-red-400"
                        }`}>{e.scope_estimate}</span>
                      ) : "—"}
                    </td>
                    <td className="p-3">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${DECISION_COLORS[e.decision] || "bg-zinc-700 text-zinc-400"}`}>
                        {e.decision.replace(/_/g, " ")}
                      </span>
                      {e.decision_overridden_by && (
                        <div className="text-[9px] text-zinc-600 mt-0.5">by {e.decision_overridden_by}</div>
                      )}
                    </td>
                    <td className="p-3 text-xs text-zinc-500 max-w-[200px] truncate">
                      {e.reasoning || "—"}
                    </td>
                    <td className="p-3 text-xs text-zinc-600 whitespace-nowrap">
                      {new Date(e.created_at).toLocaleString()}
                    </td>
                    <td className="p-3">
                      {e.decision === "board_review" && (
                        <div className="flex gap-1">
                          <button
                            onClick={() => handleOverride(e.id, "auto_assigned")}
                            disabled={overriding === e.id}
                            className="px-2 py-0.5 text-[10px] bg-emerald-500/20 text-emerald-300 rounded hover:bg-emerald-500/30 transition-colors disabled:opacity-40"
                          >
                            Assign
                          </button>
                          <button
                            onClick={() => handleOverride(e.id, "skipped")}
                            disabled={overriding === e.id}
                            className="px-2 py-0.5 text-[10px] bg-zinc-700 text-zinc-400 rounded hover:bg-zinc-600 transition-colors disabled:opacity-40"
                          >
                            Skip
                          </button>
                        </div>
                      )}
                      {e.campaign_id && (
                        <a href="/campaigns" className="text-[10px] text-accent-bright hover:underline">
                          View Campaign
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
