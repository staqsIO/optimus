"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import dynamic from "next/dynamic";
import { opsFetch, opsPost } from "@/lib/ops-api";
import { useEventStream } from "@/hooks/useEventStream";
import { usePageContext } from "@/contexts/PageContext";

import OptimusMcpPanel from "@/components/OptimusMcpPanel";

// Lazy-load Graph, Runs, Activity as tab panes
const SystemGraph = dynamic(() => import("@/components/graph/SystemGraph"), {
  ssr: false,
  loading: () => <div className="flex items-center justify-center h-full text-sm text-zinc-500">Loading graph...</div>,
});
const RunsTab = dynamic(() => import("@/app/runs/RunsContent"), {
  loading: () => <div className="py-8 text-center text-sm text-zinc-500">Loading runs...</div>,
});
const ActivityTab = dynamic(() => import("@/app/activity/ActivityContent"), {
  loading: () => <div className="py-8 text-center text-sm text-zinc-500">Loading activity...</div>,
});
const TriageTab = dynamic(() => import("@/components/TriageQueue"), {
  loading: () => <div className="py-8 text-center text-sm text-zinc-500">Loading triage...</div>,
});
const ServicesTab = dynamic(() => import("@/components/ServicesTab"), {
  loading: () => <div className="py-8 text-center text-sm text-zinc-500">Loading services...</div>,
});
const LearningTab = dynamic(() => import("./LearningTab"), {
  loading: () => <div className="py-8 text-center text-sm text-zinc-500">Loading learning...</div>,
});

interface AgentConfig {
  id: string;
  type: string;
  enabled: boolean;
  model: string;
  maxTokens: number;
  temperature: number;
  tools: string[];
  guardrails: string[];
  chat?: { enabled?: boolean; maxCostPerSession?: number };
  [key: string]: unknown;
}

interface ModelConfig {
  provider: string;
  inputCostPer1M: number;
  outputCostPer1M: number;
  contextWindow: number;
  maxOutput: number;
}

interface ChangelogEntry {
  timestamp: string;
  boardUser: string;
  agentId: string | null;
  modelKey: string | null;
  changes: Record<string, unknown>;
}

interface AgentRuntimeStatus {
  online: boolean;
  enabled: boolean;
  status: "idle" | "processing" | "stopped" | "offline";
  tier: string | null;
  subTier: string | null;
  model: string | null;
  lastSeen: string | null;
  lastTaskAt: string | null;
  currentTask: { id: string; title: string; type: string } | null;
  pid: number | null;
  machineName: string | null;
  machineArch: string | null;
  clientVersion: string | null;
}

interface ConfigData {
  agents: Record<string, AgentConfig>;
  models: Record<string, ModelConfig>;
}

const TYPE_COLORS: Record<string, string> = {
  orchestrator: "bg-purple-500/20 text-purple-300",
  strategist: "bg-blue-500/20 text-blue-300",
  executor: "bg-emerald-500/20 text-emerald-300",
  reviewer: "bg-yellow-500/20 text-yellow-300",
  architect: "bg-orange-500/20 text-orange-300",
  utility: "bg-zinc-500/20 text-zinc-300",
  external: "bg-teal-500/20 text-teal-300",
};

const PROVIDER_COLORS: Record<string, string> = {
  anthropic: "bg-amber-500/20 text-amber-300",
  openrouter: "bg-cyan-500/20 text-cyan-300",
};

// ── Agent Hub: Config | Graph | Runs | Activity ───────────────────────────────

type AgentTab = "config" | "graph" | "runs" | "activity" | "triage" | "services" | "learning";

function AgentHubInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const tab = (searchParams.get("tab") as AgentTab) || "config";

  function setTab(t: AgentTab) {
    router.push(`/agents${t === "config" ? "" : `?tab=${t}`}`, { scroll: false });
  }

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="shrink-0 flex gap-1 px-4 pt-4 pb-0">
        {(["config", "graph", "runs", "activity", "triage", "services", "learning"] as AgentTab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-1.5 text-xs rounded-t-lg capitalize transition-colors ${
              tab === t
                ? "bg-zinc-800 text-zinc-100 border border-white/10 border-b-0"
                : "text-zinc-500 hover:text-zinc-300 hover:bg-white/5"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0">
        {tab === "config" && <AgentConfigTab />}
        {tab === "graph" && (
          <div className="h-full min-h-[400px]">
            <SystemGraph />
          </div>
        )}
        {tab === "runs" && <RunsTab />}
        {tab === "activity" && <ActivityTab />}
        {tab === "triage" && <TriageTab />}
        {tab === "services" && <ServicesTab />}
        {tab === "learning" && <LearningTab />}
      </div>
    </div>
  );
}

export default function AgentsPage() {
  return (
    <Suspense fallback={<div className="p-4 text-zinc-500 text-sm">Loading...</div>}>
      <AgentHubInner />
    </Suspense>
  );
}

// ── Config Tab (original agents page content) ─────────────────────────────────

function AgentConfigTab() {
  const { setCurrentPage } = usePageContext();
  useEffect(() => { setCurrentPage({ route: "/agents", title: "Agents" }); return () => setCurrentPage(null); }, [setCurrentPage]);

  const [config, setConfig] = useState<ConfigData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [editAgent, setEditAgent] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<Partial<AgentConfig>>({});
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [changelog, setChangelog] = useState<ChangelogEntry[]>([]);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [runtimeStatus, setRuntimeStatus] = useState<Record<string, AgentRuntimeStatus>>({});

  const load = useCallback(async () => {
    const [data, changelogRes, statusRes] = await Promise.all([
      opsFetch<ConfigData>("/api/agents/config"),
      opsFetch<{ entries: ChangelogEntry[] }>("/api/agents/changelog?limit=10"),
      opsFetch<{ statuses: Record<string, AgentRuntimeStatus> }>("/api/agents/status"),
    ]);
    if (data) setConfig(data);
    if (changelogRes) setChangelog(changelogRes.entries);
    if (statusRes) setRuntimeStatus(statusRes.statuses);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Refresh status on agent toggle or state change events (replaces 15s polling)
  useEventStream("agent_toggled", useCallback(() => { load(); }, [load]));
  useEventStream("state_changed", useCallback(() => {
    // Only refresh status, not full config
    opsFetch<{ statuses: Record<string, AgentRuntimeStatus> }>("/api/agents/status")
      .then((res) => { if (res) setRuntimeStatus(res.statuses); });
  }, []));

  // Fallback poll at 15s (SSE accelerates when connected)
  useEffect(() => {
    const interval = setInterval(async () => {
      const statusRes = await opsFetch<{ statuses: Record<string, AgentRuntimeStatus> }>("/api/agents/status");
      if (statusRes) setRuntimeStatus(statusRes.statuses);
    }, 15_000);
    return () => clearInterval(interval);
  }, []);

  function startEdit(agentId: string) {
    if (!config) return;
    const agent = config.agents[agentId];
    setEditAgent(agentId);
    setEditValues({
      model: agent.model,
      temperature: agent.temperature,
      maxTokens: agent.maxTokens,
      enabled: agent.enabled,
    });
  }

  function cancelEdit() {
    setEditAgent(null);
    setEditValues({});
  }

  async function saveAgent(agentId: string) {
    if (!config) return;
    const agent = config.agents[agentId];

    // Only send changed values
    const changes: Record<string, unknown> = {};
    if (editValues.model !== agent.model) changes.model = editValues.model;
    if (editValues.temperature !== agent.temperature) changes.temperature = editValues.temperature;
    if (editValues.maxTokens !== agent.maxTokens) changes.maxTokens = editValues.maxTokens;
    if (editValues.enabled !== agent.enabled) changes.enabled = editValues.enabled;

    if (Object.keys(changes).length === 0) {
      cancelEdit();
      return;
    }

    setSaving(agentId);
    const result = await opsPost("/api/agents/config", { agentId, changes });
    setSaving(null);

    if (result.ok) {
      setToast({ msg: `${agentId} updated — restart agents to apply`, ok: true });
      cancelEdit();
      load();
    } else {
      setToast({ msg: result.error, ok: false });
    }

    setTimeout(() => setToast(null), 4000);
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <div className="text-zinc-500 text-sm">Loading agent config...</div>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <div className="text-red-400 text-sm">Failed to load agent config. Is the backend running?</div>
      </div>
    );
  }

  const allAgents = Object.values(config.agents);
  // External agents are shown in OptimusMcpPanel — filter from main table to avoid duplication
  const agents = allAgents.filter((a) => a.type !== "external");
  const models = config.models;
  const modelKeys = Object.keys(models);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-200 p-6">
      <div className="max-w-7xl mx-auto space-y-8">
        {/* Toast */}
        {toast && (
          <div className={`fixed top-16 right-6 z-50 px-4 py-2 rounded-lg text-sm font-medium shadow-lg animate-fade-in ${toast.ok ? "bg-emerald-600 text-white" : "bg-red-600 text-white"}`}>
            {toast.msg}
          </div>
        )}

        {/* Header */}
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Agent Configuration</h1>
          <p className="text-sm text-zinc-500 mt-1">
            Edit model assignments, temperature, and token limits. Changes write to agents.json — restart agents to apply.
          </p>
        </div>

        {/* Models Overview */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-medium text-zinc-300">Available Models</h2>
            <Link
              href="/agents/models"
              className="px-3 py-1.5 text-xs bg-zinc-800 text-zinc-300 rounded-lg hover:bg-zinc-700 transition-colors border border-white/10"
            >
              Manage Models
            </Link>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {modelKeys.map((key) => {
              const m = models[key];
              const agentCount = agents.filter((a) => a.model === key).length;
              return (
                <div
                  key={key}
                  className="bg-zinc-900 border border-white/5 rounded-lg p-4"
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${PROVIDER_COLORS[m.provider] || "bg-zinc-700 text-zinc-300"}`}>
                      {m.provider}
                    </span>
                    <span className="text-sm font-medium text-zinc-200 truncate">{key}</span>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-zinc-500">
                    <span>${m.inputCostPer1M}/{m.outputCostPer1M} per 1M</span>
                    <span>{(m.contextWindow / 1000).toFixed(0)}K ctx</span>
                    <span>{agentCount} agent{agentCount !== 1 ? "s" : ""}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* External Agents (Optimus MCP) */}
        <OptimusMcpPanel />

        {/* Agent Table */}
        <section>
          <h2 className="text-lg font-medium text-zinc-300 mb-3">Agents</h2>
          <div className="bg-zinc-900 border border-white/5 rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/5 text-xs text-zinc-500 uppercase tracking-wider">
                    <th className="text-left px-4 py-3 font-medium">Agent</th>
                    <th className="text-left px-4 py-3 font-medium">Type</th>
                    <th className="text-left px-4 py-3 font-medium">Model</th>
                    <th className="text-left px-4 py-3 font-medium">Provider</th>
                    <th className="text-right px-4 py-3 font-medium">Temp</th>
                    <th className="text-right px-4 py-3 font-medium">Max Tokens</th>
                    <th className="text-center px-4 py-3 font-medium">Runtime</th>
                    <th className="text-left px-4 py-3 font-medium">Tools &amp; Skills</th>
                    <th className="text-center px-4 py-3 font-medium">Chat</th>
                    <th className="text-center px-4 py-3 font-medium">Enabled</th>
                    <th className="text-right px-4 py-3 font-medium w-24"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {agents.map((agent) => {
                    const isEditing = editAgent === agent.id;
                    const model = models[isEditing ? (editValues.model || agent.model) : agent.model];
                    const provider = model?.provider || "unknown";

                    return (
                      <tr
                        key={agent.id}
                        className={`hover:bg-white/[0.02] transition-colors ${!agent.enabled ? "opacity-50" : ""}`}
                      >
                        {/* Agent ID */}
                        <td className="px-4 py-3">
                          <Link
                            href={`/agents/${encodeURIComponent(agent.id)}`}
                            className="font-medium text-zinc-200 hover:text-blue-400 hover:underline underline-offset-2 transition-colors"
                          >
                            {agent.id}
                          </Link>
                        </td>

                        {/* Type */}
                        <td className="px-4 py-3">
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${TYPE_COLORS[agent.type] || "bg-zinc-700 text-zinc-300"}`}>
                            {agent.type}
                          </span>
                        </td>

                        {/* Model */}
                        <td className="px-4 py-3">
                          {isEditing ? (
                            <ModelSelector
                              value={editValues.model || agent.model}
                              onChange={(v) => setEditValues({ ...editValues, model: v })}
                              models={models}
                              modelKeys={modelKeys}
                              agentTier={agent.type}
                            />
                          ) : (
                            <div className="flex items-center gap-1.5">
                              <span className="text-zinc-300 text-xs font-mono">{agent.model}</span>
                              {model && (
                                <span className="text-[9px] text-zinc-600">${model.inputCostPer1M}/{model.outputCostPer1M}</span>
                              )}
                            </div>
                          )}
                        </td>

                        {/* Provider */}
                        <td className="px-4 py-3">
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${PROVIDER_COLORS[provider] || "bg-zinc-700 text-zinc-300"}`}>
                            {provider}
                          </span>
                        </td>

                        {/* Temperature */}
                        <td className="px-4 py-3 text-right">
                          {isEditing ? (
                            <input
                              type="number"
                              step="0.1"
                              min="0"
                              max="2"
                              value={editValues.temperature ?? agent.temperature}
                              onChange={(e) => setEditValues({ ...editValues, temperature: parseFloat(e.target.value) })}
                              className="w-16 bg-zinc-800 border border-white/10 rounded px-2 py-1 text-xs text-zinc-200 text-right focus:outline-none focus:border-accent-bright"
                            />
                          ) : (
                            <span className="text-zinc-400 text-xs">{agent.temperature}</span>
                          )}
                        </td>

                        {/* Max Tokens */}
                        <td className="px-4 py-3 text-right">
                          {isEditing ? (
                            <input
                              type="number"
                              step="256"
                              min="256"
                              value={editValues.maxTokens ?? agent.maxTokens}
                              onChange={(e) => setEditValues({ ...editValues, maxTokens: parseInt(e.target.value, 10) })}
                              className="w-20 bg-zinc-800 border border-white/10 rounded px-2 py-1 text-xs text-zinc-200 text-right focus:outline-none focus:border-accent-bright"
                            />
                          ) : (
                            <span className="text-zinc-400 text-xs">{agent.maxTokens?.toLocaleString()}</span>
                          )}
                        </td>

                        {/* Runtime Status */}
                        <td className="px-4 py-3 text-center">
                          {(() => {
                            const rs = runtimeStatus[agent.id];
                            if (rs?.online) {
                              const label = rs.status === "processing" ? "Online (processing)" : "Online (idle)";
                              return (
                                <div className="inline-flex flex-col items-center gap-0.5">
                                  <span className="inline-flex items-center gap-1.5" title={label}>
                                    <span className="relative inline-block w-2 h-2">
                                      <span className="absolute inset-0 rounded-full bg-emerald-400 animate-ping opacity-75" />
                                      <span className="relative inline-block w-2 h-2 rounded-full bg-emerald-500" />
                                    </span>
                                    <span className="text-xs text-zinc-500">{rs.status === "processing" ? "busy" : "idle"}</span>
                                  </span>
                                  {rs.currentTask ? (
                                    <span className="text-[10px] text-zinc-600 truncate max-w-[120px]" title={rs.currentTask.title}>
                                      {rs.currentTask.title}
                                    </span>
                                  ) : null}
                                </div>
                              );
                            }
                            return (
                              <span className="inline-flex items-center gap-1.5" title={rs?.lastSeen ? `Offline (last seen ${new Date(rs.lastSeen).toLocaleTimeString()})` : "Offline"}>
                                <span className="inline-block w-2 h-2 rounded-full bg-zinc-600" />
                                <span className="text-xs text-zinc-600">offline</span>
                              </span>
                            );
                          })()}
                        </td>

                        {/* Tools */}
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-1 max-w-[200px]">
                            {(agent.tools || []).slice(0, 7).map((tool) => (
                              <span key={tool} className="px-1.5 py-0.5 rounded text-[10px] bg-blue-500/10 text-blue-400 border border-blue-500/20">
                                {tool}
                              </span>
                            ))}
                            {(agent.tools?.length || 0) > 7 ? (
                              <span className="px-1.5 py-0.5 rounded text-[10px] text-zinc-500">
                                +{(agent.tools?.length || 0) - 7}
                              </span>
                            ) : null}
                            {(agent.tools?.length || 0) === 0 ? (
                              <span className="text-[10px] text-zinc-600">none</span>
                            ) : null}
                          </div>
                        </td>

                        {/* Chat Availability */}
                        <td className="px-4 py-3 text-center">
                          {agent.chat?.enabled ? (
                            <span title="Chat enabled" className="text-blue-400">
                              <svg className="w-4 h-4 inline-block" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z" />
                              </svg>
                            </span>
                          ) : (
                            <span className="text-zinc-700">&#8212;</span>
                          )}
                        </td>

                        {/* Enabled (config) */}
                        <td className="px-4 py-3 text-center">
                          {isEditing ? (
                            <button
                              onClick={() => setEditValues({ ...editValues, enabled: !editValues.enabled })}
                              className={`w-10 h-5 rounded-full transition-colors ${editValues.enabled ? "bg-emerald-600" : "bg-zinc-700"}`}
                            >
                              <div className={`w-3.5 h-3.5 rounded-full bg-white transition-transform ${editValues.enabled ? "translate-x-5" : "translate-x-1"}`} />
                            </button>
                          ) : (
                            <span className={`inline-block w-2 h-2 rounded-full ${agent.enabled ? "bg-emerald-500" : "bg-zinc-600"}`} title={agent.enabled ? "Enabled" : "Disabled"} />
                          )}
                        </td>

                        {/* Actions */}
                        <td className="px-4 py-3 text-right">
                          {isEditing ? (
                            <div className="flex items-center justify-end gap-1.5">
                              <button
                                onClick={() => saveAgent(agent.id)}
                                disabled={saving === agent.id}
                                className="px-2.5 py-1 text-xs bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-700 text-white rounded transition-colors"
                              >
                                {saving === agent.id ? "..." : "Save"}
                              </button>
                              <button
                                onClick={cancelEdit}
                                className="px-2.5 py-1 text-xs bg-zinc-800 text-zinc-400 rounded hover:bg-zinc-700 transition-colors"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <div className="flex items-center justify-end gap-1.5">
                              <button
                                onClick={() => startEdit(agent.id)}
                                className="px-2.5 py-1 text-xs bg-zinc-800 text-zinc-400 rounded hover:bg-zinc-700 hover:text-zinc-200 transition-colors"
                              >
                                Edit
                              </button>
                              <Link
                                href={`/agents/${encodeURIComponent(agent.id)}`}
                                className="px-2 py-1 text-xs text-zinc-500 hover:text-zinc-200 transition-colors"
                                title="View detail"
                              >
                                &rarr;
                              </Link>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* Recent Config Changes */}
        {changelog.length > 0 && (
          <section>
            <button
              onClick={() => setChangelogOpen(!changelogOpen)}
              className="flex items-center gap-2 text-sm text-zinc-400 hover:text-zinc-300 transition-colors mb-2"
            >
              <span className="text-xs">{changelogOpen ? "\u25BC" : "\u25B6"}</span>
              Recent Config Changes ({changelog.length})
            </button>
            {changelogOpen && (
              <div className="bg-zinc-900 border border-white/5 rounded-lg p-4 space-y-2">
                {changelog.map((entry, i) => (
                  <div key={i} className="flex items-center gap-3 text-xs">
                    <span className="text-zinc-600 w-36 shrink-0">
                      {new Date(entry.timestamp).toLocaleString()}
                    </span>
                    <span className="text-zinc-400">{entry.boardUser}</span>
                    {entry.agentId && (
                      <Link href={`/agents/${encodeURIComponent(entry.agentId)}`} className="text-blue-400 hover:underline">
                        {entry.agentId}
                      </Link>
                    )}
                    {entry.modelKey && <span className="text-cyan-400 font-mono">{entry.modelKey}</span>}
                    <span className="text-zinc-300 font-mono truncate">
                      {Object.entries(entry.changes).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

// ── Model Selector with pricing + role suggestions ────────────────────────────

// Liotta's tier → model category mapping
const TIER_SUGGESTIONS: Record<string, { label: string; prefer: 'cheap' | 'quality' | 'balanced' }> = {
  executor: { label: 'Fast & cheap', prefer: 'cheap' },
  orchestrator: { label: 'Balanced', prefer: 'balanced' },
  strategist: { label: 'Highest quality', prefer: 'quality' },
  architect: { label: 'High quality', prefer: 'quality' },
  reviewer: { label: 'High quality (governance)', prefer: 'quality' },
  utility: { label: 'Cheapest', prefer: 'cheap' },
  external: { label: 'Balanced', prefer: 'balanced' },
};

function getSuggestion(agentTier: string): { label: string; prefer: string } {
  return TIER_SUGGESTIONS[agentTier] || { label: 'Any', prefer: 'balanced' };
}

function ModelSelector({
  value,
  onChange,
  models,
  modelKeys,
  agentTier,
}: {
  value: string;
  onChange: (v: string) => void;
  models: Record<string, ModelConfig>;
  modelKeys: string[];
  agentTier: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const suggestion = getSuggestion(agentTier);

  // Sort models: suggested first, then by cost
  const sorted = [...modelKeys].sort((a, b) => {
    const ma = models[a];
    const mb = models[b];
    if (!ma || !mb) return 0;
    const costA = (ma.inputCostPer1M || 0) + (ma.outputCostPer1M || 0);
    const costB = (mb.inputCostPer1M || 0) + (mb.outputCostPer1M || 0);
    if (suggestion.prefer === 'cheap') return costA - costB;
    if (suggestion.prefer === 'quality') return costB - costA; // Expensive first for quality tiers
    return 0;
  });

  const filtered = search
    ? sorted.filter(k => k.toLowerCase().includes(search.toLowerCase()))
    : sorted;

  const currentModel = models[value];

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 bg-zinc-800 border border-white/10 rounded px-2 py-1 text-xs text-zinc-200 hover:border-white/20 transition-colors w-full max-w-[280px] text-left"
      >
        <span className="truncate flex-1 font-mono">{value}</span>
        {currentModel && (
          <span className="text-[9px] text-zinc-500 shrink-0">
            ${currentModel.inputCostPer1M}/{currentModel.outputCostPer1M}
          </span>
        )}
        <svg className="w-3 h-3 text-zinc-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
    );
  }

  return (
    <div className="relative w-full max-w-[320px]">
      {/* Search input */}
      <input
        autoFocus
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}
        placeholder="Search models..."
        className="w-full bg-zinc-800 border border-accent-bright/50 rounded-t px-2 py-1.5 text-xs text-zinc-200 focus:outline-none"
      />

      {/* Suggestion badge */}
      <div className="px-2 py-1 bg-zinc-900 border-x border-white/10 text-[9px] text-zinc-500">
        Suggested for <span className="text-zinc-400">{agentTier}</span>: {suggestion.label}
      </div>

      {/* Model list */}
      <div className="bg-zinc-900 border border-white/10 border-t-0 rounded-b max-h-[240px] overflow-y-auto">
        {filtered.map((key) => {
          const m = models[key];
          if (!m) return null;
          const cost = (m.inputCostPer1M || 0) + (m.outputCostPer1M || 0);
          const isCheap = cost < 2;
          const isExpensive = cost > 20;
          const isSelected = key === value;

          return (
            <button
              key={key}
              onClick={() => { onChange(key); setOpen(false); setSearch(""); }}
              className={`w-full text-left px-2 py-1.5 text-xs transition-colors flex items-center gap-2 ${
                isSelected ? "bg-accent-bright/10 text-zinc-100" : "text-zinc-300 hover:bg-white/5"
              }`}
            >
              <div className="flex-1 min-w-0">
                <div className="font-mono truncate">{key}</div>
                <div className="flex items-center gap-2 text-[9px] text-zinc-600 mt-0.5">
                  <span className={`px-1 py-0.5 rounded ${
                    m.provider === 'anthropic' ? 'bg-orange-500/10 text-orange-400' :
                    m.provider === 'openrouter' ? 'bg-blue-500/10 text-blue-400' :
                    'bg-zinc-700 text-zinc-400'
                  }`}>{m.provider}</span>
                  <span>${m.inputCostPer1M}/${m.outputCostPer1M} per 1M</span>
                  <span>{(m.contextWindow / 1000).toFixed(0)}K</span>
                </div>
              </div>
              {isCheap && <span className="px-1 py-0.5 rounded text-[8px] bg-emerald-500/10 text-emerald-400 shrink-0">$</span>}
              {isExpensive && <span className="px-1 py-0.5 rounded text-[8px] bg-amber-500/10 text-amber-400 shrink-0">$$$</span>}
              {isSelected && <span className="text-accent-bright shrink-0">&#10003;</span>}
            </button>
          );
        })}
        {filtered.length === 0 && (
          <div className="px-2 py-3 text-xs text-zinc-600 text-center">No models match "{search}"</div>
        )}
      </div>

      {/* Backdrop to close */}
      <div className="fixed inset-0 z-[-1]" onClick={() => { setOpen(false); setSearch(""); }} />
    </div>
  );
}
