"use client";

import { useEffect, useState } from "react";
import { opsFetch } from "@/lib/ops-api";

interface RetrospectiveSummary {
  totalTasks: number;
  retrospected: number;
  skipped: number;
  failures: number;
  patterns: number;
  llmRetrospects: number;
  totalCostUsd: number;
}

interface SkillPerformanceRow {
  agent_id: string;
  event_type: string;
  tool_name: string;
  total_runs: number;
  success_count: number;
  fail_count: number;
  avg_duration_ms: number;
  avg_cost_usd: number;
  last_run_at: string;
}

interface RetrospectiveLogEntry {
  id: string;
  work_item_id: string;
  agent_id: string;
  classification: string;
  route: string | null;
  learning_type: string | null;
  cost_usd: number;
  metadata: Record<string, unknown>;
  created_at: string;
}

interface RetrospectiveData {
  summary: RetrospectiveSummary;
  skillPerformance: SkillPerformanceRow[];
  recentRetrospectives: RetrospectiveLogEntry[];
}

interface MemoryEntry {
  id: string;
  type: "pattern" | "preference" | "context" | "failure";
  content: string;
  work_item_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

interface MemoriesResponse {
  agentId: string;
  counts: { pattern: number; failure: number; preference: number; context: number };
  memories: MemoryEntry[];
}

const MEMORY_TYPE_BADGE: Record<string, string> = {
  pattern: "bg-blue-500/20 text-blue-300",
  failure: "bg-red-500/20 text-red-300",
  preference: "bg-purple-500/20 text-purple-300",
  context: "bg-zinc-600/30 text-zinc-400",
};

const CLASSIFICATION_BADGE: Record<string, string> = {
  skip: "bg-zinc-600/30 text-zinc-400",
  failure: "bg-red-500/20 text-red-300",
  pattern: "bg-blue-500/20 text-blue-300",
  llm_retrospect: "bg-amber-500/20 text-amber-300",
};

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-lg px-4 py-3">
      <div className="text-xs text-zinc-500 mb-1">{label}</div>
      <div className="text-xl font-mono text-zinc-100">{value}</div>
      {sub && <div className="text-xs text-zinc-500 mt-0.5">{sub}</div>}
    </div>
  );
}

export default function LearningTab() {
  const [data, setData] = useState<RetrospectiveData | null>(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState("7");
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [memData, setMemData] = useState<MemoriesResponse | null>(null);
  const [memLoading, setMemLoading] = useState(false);
  const [memTypeFilter, setMemTypeFilter] = useState<MemoryEntry["type"] | "all">("all");

  useEffect(() => {
    if (!selectedAgent) return;
    (async () => {
      setMemLoading(true);
      try {
        const result = await opsFetch(`/api/agents/memories?agentId=${selectedAgent}`) as MemoriesResponse;
        setMemData(result);
      } catch {
        setMemData(null);
      }
      setMemLoading(false);
    })();
  }, [selectedAgent]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const result = await opsFetch(`/api/agents/retrospective?period=${period}d`) as RetrospectiveData;
        setData(result);
      } catch {
        setData(null);
      }
      setLoading(false);
    })();
  }, [period]);

  if (loading) {
    return <div className="py-12 text-center text-sm text-zinc-500">Loading learning data...</div>;
  }

  if (!data || (data.summary.totalTasks === 0 && data.skillPerformance.length === 0)) {
    return (
      <div className="py-12 text-center">
        <div className="text-zinc-500 text-sm">No retrospective data yet</div>
        <div className="text-zinc-600 text-xs mt-1">
          Data will appear here once the agent runtime runs with the retrospector active.
        </div>
      </div>
    );
  }

  const { summary, skillPerformance, recentRetrospectives } = data;
  const successRate = skillPerformance.length > 0
    ? Math.round(
        (skillPerformance.reduce((s, r) => s + r.success_count, 0) /
          Math.max(1, skillPerformance.reduce((s, r) => s + r.total_runs, 0))) * 100
      )
    : 0;

  return (
    <div className="p-4 space-y-6 overflow-y-auto max-h-[calc(100vh-120px)]">
      {/* Period selector */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-zinc-500">Period:</span>
        {["1", "7", "30"].map((p) => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            className={`px-2 py-0.5 text-xs rounded ${
              period === p
                ? "bg-zinc-700 text-zinc-200"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {p}d
          </button>
        ))}
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        <StatCard label="Total Tasks" value={summary.totalTasks} />
        <StatCard
          label="Retrospected"
          value={summary.retrospected - summary.skipped}
          sub={`${summary.skipped} skipped`}
        />
        <StatCard label="Failures" value={summary.failures} />
        <StatCard label="Patterns" value={summary.patterns} />
        <StatCard label="LLM Calls" value={summary.llmRetrospects} />
        <StatCard
          label="Retro Cost"
          value={`$${summary.totalCostUsd.toFixed(4)}`}
          sub={`${successRate}% success rate`}
        />
      </div>

      {/* Skill Performance */}
      {skillPerformance.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-zinc-300 mb-2">Skill Performance</h3>
          <div className="overflow-x-auto border border-zinc-700/50 rounded-lg">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-zinc-700/50 text-zinc-500">
                  <th className="text-left px-3 py-2">Agent</th>
                  <th className="text-left px-3 py-2">Event Type</th>
                  <th className="text-right px-3 py-2">Runs</th>
                  <th className="text-right px-3 py-2">Success</th>
                  <th className="text-right px-3 py-2">Fail</th>
                  <th className="text-right px-3 py-2">Avg Duration</th>
                  <th className="text-right px-3 py-2">Avg Cost</th>
                  <th className="text-right px-3 py-2">Last Run</th>
                </tr>
              </thead>
              <tbody>
                {skillPerformance.map((row, i) => {
                  const rate = row.total_runs > 0
                    ? Math.round((row.success_count / row.total_runs) * 100)
                    : 0;
                  return (
                    <tr
                      key={i}
                      onClick={() => setSelectedAgent(row.agent_id)}
                      className="border-b border-zinc-800/50 hover:bg-zinc-800/30 cursor-pointer"
                    >
                      <td className="px-3 py-1.5 text-zinc-300 font-mono">
                        {row.agent_id}
                      </td>
                      <td className="px-3 py-1.5 text-zinc-400">{row.event_type}</td>
                      <td className="px-3 py-1.5 text-right text-zinc-300">
                        {row.total_runs}
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        <span className={rate >= 90 ? "text-emerald-400" : rate >= 70 ? "text-amber-400" : "text-red-400"}>
                          {row.success_count} ({rate}%)
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-right text-red-400/70">
                        {row.fail_count || "—"}
                      </td>
                      <td className="px-3 py-1.5 text-right text-zinc-400">
                        {Number(row.avg_duration_ms).toLocaleString()}ms
                      </td>
                      <td className="px-3 py-1.5 text-right text-zinc-400">
                        ${Number(row.avg_cost_usd).toFixed(4)}
                      </td>
                      <td className="px-3 py-1.5 text-right text-zinc-500">
                        {new Date(row.last_run_at).toLocaleDateString()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Recent Retrospectives */}
      {recentRetrospectives.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-zinc-300 mb-2">Recent Retrospectives</h3>
          <div className="overflow-x-auto border border-zinc-700/50 rounded-lg">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-zinc-700/50 text-zinc-500">
                  <th className="text-left px-3 py-2">Time</th>
                  <th className="text-left px-3 py-2">Agent</th>
                  <th className="text-left px-3 py-2">Classification</th>
                  <th className="text-left px-3 py-2">Route</th>
                  <th className="text-left px-3 py-2">Learning Type</th>
                  <th className="text-right px-3 py-2">Cost</th>
                </tr>
              </thead>
              <tbody>
                {recentRetrospectives.map((entry) => (
                  <tr
                    key={entry.id}
                    className="border-b border-zinc-800/50 hover:bg-zinc-800/30"
                  >
                    <td className="px-3 py-1.5 text-zinc-500">
                      {new Date(entry.created_at).toLocaleString()}
                    </td>
                    <td className="px-3 py-1.5 text-zinc-300 font-mono">
                      {entry.agent_id}
                    </td>
                    <td className="px-3 py-1.5">
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                          CLASSIFICATION_BADGE[entry.classification] || "bg-zinc-700 text-zinc-300"
                        }`}
                      >
                        {entry.classification}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-zinc-400">
                      {entry.route || "—"}
                    </td>
                    <td className="px-3 py-1.5 text-zinc-400">
                      {entry.learning_type || "—"}
                    </td>
                    <td className="px-3 py-1.5 text-right text-zinc-500">
                      {entry.cost_usd > 0 ? `$${Number(entry.cost_usd).toFixed(4)}` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Memory drawer */}
      {selectedAgent && (
        <div className="fixed inset-0 z-50 flex justify-end" onClick={() => setSelectedAgent(null)}>
          <div className="absolute inset-0 bg-black/50" />
          <div
            className="relative w-full max-w-2xl bg-zinc-900 border-l border-zinc-700 overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sticky top-0 bg-zinc-900 border-b border-zinc-700 px-4 py-3 flex items-center justify-between z-10">
              <div>
                <div className="text-xs text-zinc-500">Agent Memories</div>
                <div className="text-sm font-mono text-zinc-100">{selectedAgent}</div>
              </div>
              <button
                onClick={() => setSelectedAgent(null)}
                className="text-zinc-400 hover:text-zinc-200 text-xl leading-none"
              >
                ×
              </button>
            </div>

            <div className="p-4 space-y-4">
              {memLoading ? (
                <div className="text-center text-sm text-zinc-500 py-8">Loading memories...</div>
              ) : !memData || memData.memories.length === 0 ? (
                <div className="text-center py-8">
                  <div className="text-sm text-zinc-500">No memories stored yet for this agent</div>
                  <div className="text-xs text-zinc-600 mt-1">
                    Memories accumulate as the retrospector classifies task outcomes.
                  </div>
                </div>
              ) : (
                <>
                  {/* Memory counts */}
                  <div className="grid grid-cols-4 gap-2">
                    {(["pattern", "failure", "preference", "context"] as const).map((t) => (
                      <div key={t} className="bg-zinc-800/50 border border-zinc-700/50 rounded px-3 py-2">
                        <div className="text-[10px] text-zinc-500 uppercase">{t}</div>
                        <div className="text-lg font-mono text-zinc-100">
                          {memData.counts[t] || 0}
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Type filter */}
                  <div className="flex gap-1">
                    {(["all", "pattern", "failure", "preference", "context"] as const).map((t) => (
                      <button
                        key={t}
                        onClick={() => setMemTypeFilter(t)}
                        className={`px-2 py-0.5 text-xs rounded ${
                          memTypeFilter === t
                            ? "bg-zinc-700 text-zinc-200"
                            : "text-zinc-500 hover:text-zinc-300"
                        }`}
                      >
                        {t}
                      </button>
                    ))}
                  </div>

                  {/* Memory list */}
                  <div className="space-y-2">
                    {memData.memories
                      .filter((m) => memTypeFilter === "all" || m.type === memTypeFilter)
                      .map((mem) => (
                        <div
                          key={mem.id}
                          className="bg-zinc-800/30 border border-zinc-700/50 rounded p-3 text-xs"
                        >
                          <div className="flex items-center justify-between mb-2">
                            <span
                              className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                                MEMORY_TYPE_BADGE[mem.type] || "bg-zinc-700 text-zinc-300"
                              }`}
                            >
                              {mem.type}
                            </span>
                            <span className="text-zinc-500 text-[10px]">
                              {new Date(mem.created_at).toLocaleString()}
                            </span>
                          </div>
                          <div className="text-zinc-200 whitespace-pre-wrap leading-relaxed">
                            {mem.content}
                          </div>
                          {mem.metadata && Object.keys(mem.metadata).length > 0 && (
                            <div className="mt-2 pt-2 border-t border-zinc-700/50 flex flex-wrap gap-1">
                              {Object.entries(mem.metadata)
                                .filter(([k]) => k !== "durationMs" && k !== "costUsd")
                                .slice(0, 5)
                                .map(([k, v]) => (
                                  <span
                                    key={k}
                                    className="text-[10px] text-zinc-500 bg-zinc-800 px-1.5 py-0.5 rounded"
                                  >
                                    {k}: {String(v).slice(0, 30)}
                                  </span>
                                ))}
                            </div>
                          )}
                        </div>
                      ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
