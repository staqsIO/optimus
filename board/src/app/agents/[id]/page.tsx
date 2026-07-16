"use client";

import { useEffect, useState, useCallback, use } from "react";
import Link from "next/link";
import { opsFetch, opsPost } from "@/lib/ops-api";

// --- Types ---

interface HierarchyConfig {
  canDelegate?: string[];
  reportsTo?: string;
  escalatesTo?: string;
}

interface ChatConfig {
  enabled?: boolean;
  maxCostPerSession?: number;
  chatTools?: string[];
}

interface OutputConstraints {
  format?: string;
  antiPatterns?: string[];
  reviewDimensions?: string[];
}

interface AgentConfig {
  id: string;
  type: string;
  enabled: boolean;
  model: string;
  llmEnabled?: boolean;
  maxTokens: number;
  temperature: number;
  tools: string[];
  guardrails: string[];
  hierarchy?: HierarchyConfig;
  chat?: ChatConfig;
  outputConstraints?: OutputConstraints;
  [key: string]: unknown;
}

interface ModelConfig {
  provider: string;
  inputCostPer1M: number;
  outputCostPer1M: number;
  contextWindow: number;
  maxOutput: number;
}

interface PromptInfo {
  type: "static" | "dynamic" | "configurable";
  prompt: string;
  dynamicNote?: string;
  source: string;
}

interface ActivityStats {
  totalTasks: number;
  completed: number;
  failed: number;
  avgCostUsd: number;
  totalCostUsd: number;
  lastActive: string | null;
}

interface RecentTask {
  id: string;
  title: string;
  status: string;
  cost_usd: string | null;
  created_at: string;
  updated_at: string;
}

interface ChangelogEntry {
  timestamp: string;
  boardUser: string;
  agentId: string | null;
  modelKey: string | null;
  changes: Record<string, unknown>;
}

interface DetailData {
  agent: AgentConfig;
  model: ModelConfig | null;
  prompt: PromptInfo | null;
}

interface ActivityData {
  stats: ActivityStats;
  recentTasks: RecentTask[];
}

interface AllModels {
  models: Record<string, ModelConfig>;
}

// --- Constants ---

const TYPE_COLORS: Record<string, string> = {
  orchestrator: "bg-purple-500/20 text-purple-300",
  strategist: "bg-blue-500/20 text-blue-300",
  executor: "bg-emerald-500/20 text-emerald-300",
  reviewer: "bg-yellow-500/20 text-yellow-300",
  architect: "bg-orange-500/20 text-orange-300",
  utility: "bg-zinc-500/20 text-zinc-300",
};

const PROVIDER_COLORS: Record<string, string> = {
  anthropic: "bg-amber-500/20 text-amber-300",
  openrouter: "bg-cyan-500/20 text-cyan-300",
};

const STATUS_COLORS: Record<string, string> = {
  completed: "text-emerald-400",
  in_progress: "text-blue-400",
  assigned: "text-yellow-400",
  created: "text-zinc-400",
  review: "text-purple-400",
  cancelled: "text-red-400",
};

const PROMPT_TYPE_COLORS: Record<string, string> = {
  static: "bg-zinc-500/20 text-zinc-300",
  dynamic: "bg-blue-500/20 text-blue-300",
  configurable: "bg-emerald-500/20 text-emerald-300",
};

const GATE_DESCRIPTIONS: Record<string, string> = {
  G1: "Financial ($20/day ceiling)",
  G2: "Legal (commitment/contract scan)",
  G3: "Reputational (tone match >= 0.80)",
  G4: "Autonomy (approval level enforcement)",
  G5: "Reversibility (prefer drafts over sends)",
  G6: "Stakeholder (no spam/misleading)",
  G7: "Precedent (pricing/timeline/policy)",
};

// --- Component ---

export default function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: agentId } = use(params);
  const [detail, setDetail] = useState<DetailData | null>(null);
  const [activity, setActivity] = useState<ActivityData | null>(null);
  const [changelog, setChangelog] = useState<ChangelogEntry[]>([]);
  const [allModels, setAllModels] = useState<Record<string, ModelConfig>>({});
  const [loading, setLoading] = useState(true);
  const [promptOpen, setPromptOpen] = useState(false);
  const [constraintsOpen, setConstraintsOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  // Editable fields
  const [editModel, setEditModel] = useState("");
  const [editTemp, setEditTemp] = useState(0);
  const [editMaxTokens, setEditMaxTokens] = useState(0);
  const [editEnabled, setEditEnabled] = useState(true);
  const [editChatEnabled, setEditChatEnabled] = useState(false);
  const [editChatMaxCost, setEditChatMaxCost] = useState(0);

  const showToast = (msg: string, ok: boolean) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 4000);
  };

  const load = useCallback(async () => {
    const [detailRes, activityRes, changelogRes, configRes] = await Promise.all([
      opsFetch<DetailData>(`/api/agents/detail?agentId=${encodeURIComponent(agentId)}`),
      opsFetch<ActivityData>(`/api/agents/activity?agentId=${encodeURIComponent(agentId)}`),
      opsFetch<{ entries: ChangelogEntry[] }>(`/api/agents/changelog?agentId=${encodeURIComponent(agentId)}&limit=20`),
      opsFetch<AllModels>("/api/agents/config"),
    ]);

    if (detailRes) {
      setDetail(detailRes);
      // Initialize edit values
      setEditModel(detailRes.agent.model);
      setEditTemp(detailRes.agent.temperature);
      setEditMaxTokens(detailRes.agent.maxTokens);
      setEditEnabled(detailRes.agent.enabled);
      setEditChatEnabled(detailRes.agent.chat?.enabled ?? false);
      setEditChatMaxCost(detailRes.agent.chat?.maxCostPerSession ?? 0);
    }
    if (activityRes) setActivity(activityRes);
    if (changelogRes) setChangelog(changelogRes.entries);
    if (configRes) setAllModels(configRes.models);

    setLoading(false);
  }, [agentId]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  function startEdit() {
    if (!detail) return;
    setEditModel(detail.agent.model);
    setEditTemp(detail.agent.temperature);
    setEditMaxTokens(detail.agent.maxTokens);
    setEditEnabled(detail.agent.enabled);
    setEditChatEnabled(detail.agent.chat?.enabled ?? false);
    setEditChatMaxCost(detail.agent.chat?.maxCostPerSession ?? 0);
    setEditing(true);
  }

  async function saveChanges() {
    if (!detail) return;
    const agent = detail.agent;
    const changes: Record<string, unknown> = {};

    if (editModel !== agent.model) changes.model = editModel;
    if (editTemp !== agent.temperature) changes.temperature = editTemp;
    if (editMaxTokens !== agent.maxTokens) changes.maxTokens = editMaxTokens;
    if (editEnabled !== agent.enabled) changes.enabled = editEnabled;

    // Chat changes
    const chatChanged =
      editChatEnabled !== (agent.chat?.enabled ?? false) ||
      editChatMaxCost !== (agent.chat?.maxCostPerSession ?? 0);
    if (chatChanged) {
      changes.chat = { enabled: editChatEnabled, maxCostPerSession: editChatMaxCost };
    }

    if (Object.keys(changes).length === 0) {
      setEditing(false);
      return;
    }

    setSaving(true);
    const result = await opsPost("/api/agents/config", { agentId, changes });
    setSaving(false);

    if (result.ok) {
      showToast(`${agentId} updated — restart agents to apply`, true);
      setEditing(false);
      load();
    } else {
      showToast(result.error, false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <div className="text-zinc-500 text-sm">Loading agent detail...</div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <div className="text-red-400 text-sm">Agent not found. Is the backend running?</div>
      </div>
    );
  }

  const { agent, model, prompt } = detail;
  const modelKeys = Object.keys(allModels);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-200 p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Toast */}
        {toast && (
          <div className={`fixed top-16 right-6 z-50 px-4 py-2 rounded-lg text-sm font-medium shadow-lg ${toast.ok ? "bg-emerald-600 text-white" : "bg-red-600 text-white"}`}>
            {toast.msg}
          </div>
        )}

        {/* A. Header */}
        <div>
          <div className="flex items-center gap-2 text-sm text-zinc-500 mb-4">
            <Link href="/agents" className="hover:text-zinc-300 transition-colors">Agents</Link>
            <span>/</span>
            <span className="text-zinc-300">{agentId}</span>
          </div>

          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-2xl font-semibold tracking-tight">{agentId}</h1>
              <span className={`px-2 py-0.5 rounded text-xs font-medium ${TYPE_COLORS[agent.type] || "bg-zinc-700 text-zinc-300"}`}>
                {agent.type}
              </span>
              {model && (
                <span className={`px-2 py-0.5 rounded text-xs font-medium ${PROVIDER_COLORS[model.provider] || "bg-zinc-700 text-zinc-300"}`}>
                  {model.provider}
                </span>
              )}
              <span className={`inline-block w-2 h-2 rounded-full ${agent.enabled ? "bg-emerald-500" : "bg-zinc-600"}`} title={agent.enabled ? "Enabled" : "Disabled"} />
              {agent.llmEnabled === false && (
                <span className="px-2 py-0.5 rounded text-xs font-medium bg-red-500/20 text-red-300">LLM Disabled</span>
              )}
            </div>

            <button
              onClick={editing ? saveChanges : startEdit}
              disabled={saving}
              className={`px-3 py-1.5 text-xs rounded transition-colors flex-shrink-0 ${
                editing
                  ? "bg-emerald-600 hover:bg-emerald-500 text-white disabled:bg-zinc-700"
                  : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
              }`}
            >
              {saving ? "Saving..." : editing ? "Save Changes" : "Edit"}
            </button>
          </div>
          {editing && (
            <button onClick={() => setEditing(false)} className="mt-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
              Cancel editing
            </button>
          )}
        </div>

        {/* B. Configuration Card */}
        <div className="bg-zinc-900 border border-white/5 rounded-lg p-5 space-y-5">
          <h2 className="text-sm font-medium text-zinc-300">Configuration</h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Left: Core config */}
            <div className="space-y-4">
              <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wider">Core</h3>

              {/* Model */}
              <div>
                <label className="text-xs text-zinc-500 block mb-1">Model</label>
                {editing ? (
                  <select
                    value={editModel}
                    onChange={(e) => setEditModel(e.target.value)}
                    className="bg-zinc-800 border border-white/10 rounded px-2 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-blue-500 w-full"
                  >
                    {modelKeys.map((k) => (
                      <option key={k} value={k}>{k}</option>
                    ))}
                  </select>
                ) : (
                  <span className="text-sm font-mono text-zinc-200">{agent.model}</span>
                )}
              </div>

              {/* Temperature */}
              <div>
                <label className="text-xs text-zinc-500 block mb-1">Temperature</label>
                {editing ? (
                  <input
                    type="number" step="0.1" min="0" max="2"
                    value={editTemp}
                    onChange={(e) => setEditTemp(parseFloat(e.target.value))}
                    className="w-24 bg-zinc-800 border border-white/10 rounded px-2 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-blue-500"
                  />
                ) : (
                  <span className="text-sm text-zinc-200">{agent.temperature}</span>
                )}
              </div>

              {/* Max Tokens */}
              <div>
                <label className="text-xs text-zinc-500 block mb-1">Max Tokens</label>
                {editing ? (
                  <input
                    type="number" step="256" min="256"
                    value={editMaxTokens}
                    onChange={(e) => setEditMaxTokens(parseInt(e.target.value, 10))}
                    className="w-32 bg-zinc-800 border border-white/10 rounded px-2 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-blue-500"
                  />
                ) : (
                  <span className="text-sm text-zinc-200">{agent.maxTokens?.toLocaleString()}</span>
                )}
              </div>

              {/* Enabled */}
              <div>
                <label className="text-xs text-zinc-500 block mb-1">Enabled</label>
                {editing ? (
                  <button
                    onClick={() => setEditEnabled(!editEnabled)}
                    className={`w-10 h-5 rounded-full transition-colors ${editEnabled ? "bg-emerald-600" : "bg-zinc-700"}`}
                  >
                    <div className={`w-3.5 h-3.5 rounded-full bg-white transition-transform ${editEnabled ? "translate-x-5" : "translate-x-1"}`} />
                  </button>
                ) : (
                  <span className={`text-sm ${agent.enabled ? "text-emerald-400" : "text-zinc-500"}`}>
                    {agent.enabled ? "Yes" : "No"}
                  </span>
                )}
              </div>

              {agent.llmEnabled !== undefined && (
                <div>
                  <label className="text-xs text-zinc-500 block mb-1">LLM Enabled</label>
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${agent.llmEnabled ? "bg-emerald-500/20 text-emerald-300" : "bg-red-500/20 text-red-300"}`}>
                    {agent.llmEnabled ? "Yes" : "No"}
                  </span>
                </div>
              )}
            </div>

            {/* Right: Operational config */}
            <div className="space-y-4">
              <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wider">Operational</h3>

              {/* Tools */}
              {agent.tools && agent.tools.length > 0 && (
                <div>
                  <label className="text-xs text-zinc-500 block mb-1">Tools</label>
                  <div className="flex flex-wrap gap-1">
                    {agent.tools.map((tool) => (
                      <span key={tool} className="px-2 py-0.5 rounded text-xs bg-zinc-800 text-zinc-300 border border-white/5">{tool}</span>
                    ))}
                  </div>
                </div>
              )}

              {/* Guardrails */}
              {agent.guardrails && agent.guardrails.length > 0 && (
                <div>
                  <label className="text-xs text-zinc-500 block mb-1">Guardrails</label>
                  <div className="flex flex-wrap gap-1">
                    {agent.guardrails.map((gate) => (
                      <span key={gate} className="px-2 py-0.5 rounded text-xs bg-yellow-500/10 text-yellow-300 border border-yellow-500/20" title={GATE_DESCRIPTIONS[gate] || gate}>
                        {gate}
                      </span>
                    ))}
                  </div>
                </div>
              )}

            </div>
          </div>

          {/* Chat config sub-section */}
          {(agent.chat || editing) && (
            <div className="border-t border-white/5 pt-4">
              <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-3">Chat</h3>
              <div className="flex items-center gap-6">
                <div>
                  <label className="text-xs text-zinc-500 block mb-1">Chat Enabled</label>
                  {editing ? (
                    <button
                      onClick={() => setEditChatEnabled(!editChatEnabled)}
                      className={`w-10 h-5 rounded-full transition-colors ${editChatEnabled ? "bg-emerald-600" : "bg-zinc-700"}`}
                    >
                      <div className={`w-3.5 h-3.5 rounded-full bg-white transition-transform ${editChatEnabled ? "translate-x-5" : "translate-x-1"}`} />
                    </button>
                  ) : (
                    <span className={`text-sm ${agent.chat?.enabled ? "text-emerald-400" : "text-zinc-500"}`}>
                      {agent.chat?.enabled ? "Yes" : "No"}
                    </span>
                  )}
                </div>
                <div>
                  <label className="text-xs text-zinc-500 block mb-1">Max Cost/Session</label>
                  {editing ? (
                    <input
                      type="number" step="0.25" min="0" max="10"
                      value={editChatMaxCost}
                      onChange={(e) => setEditChatMaxCost(parseFloat(e.target.value))}
                      className="w-24 bg-zinc-800 border border-white/10 rounded px-2 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-blue-500"
                    />
                  ) : (
                    <span className="text-sm text-zinc-200">${agent.chat?.maxCostPerSession?.toFixed(2) ?? "N/A"}</span>
                  )}
                </div>
                {agent.chat?.chatTools && agent.chat.chatTools.length > 0 && (
                  <div>
                    <label className="text-xs text-zinc-500 block mb-1">Chat Tools</label>
                    <div className="flex flex-wrap gap-1">
                      {agent.chat.chatTools.map((t) => (
                        <span key={t} className="px-2 py-0.5 rounded text-xs bg-zinc-800 text-zinc-300">{t}</span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Output Constraints sub-section */}
          {agent.outputConstraints && (
            <div className="border-t border-white/5 pt-4">
              <button
                onClick={() => setConstraintsOpen(!constraintsOpen)}
                className="flex items-center gap-2 text-xs font-medium text-zinc-500 uppercase tracking-wider hover:text-zinc-300 transition-colors"
              >
                <span>{constraintsOpen ? "\u25BC" : "\u25B6"}</span>
                Output Constraints
              </button>
              {constraintsOpen && (
                <div className="mt-3 space-y-2">
                  <div className="text-xs text-zinc-400">
                    Format: <span className="text-zinc-200">{agent.outputConstraints.format}</span>
                  </div>
                  {agent.outputConstraints.antiPatterns && (
                    <div>
                      <div className="text-xs text-zinc-500 mb-1">Anti-Patterns:</div>
                      <ul className="space-y-1">
                        {agent.outputConstraints.antiPatterns.map((p, i) => (
                          <li key={i} className="text-xs text-zinc-400 pl-3 border-l border-red-500/30">{p}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {agent.outputConstraints.reviewDimensions && (
                    <div>
                      <div className="text-xs text-zinc-500 mb-1">Review Dimensions:</div>
                      <div className="flex flex-wrap gap-1">
                        {agent.outputConstraints.reviewDimensions.map((d) => (
                          <span key={d} className="px-2 py-0.5 rounded text-xs bg-purple-500/10 text-purple-300 border border-purple-500/20">{d}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* C. Hierarchy Card */}
        {agent.hierarchy && (
          <div className="bg-zinc-900 border border-white/5 rounded-lg p-5">
            <h2 className="text-sm font-medium text-zinc-300 mb-4">Hierarchy</h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {/* Reports To */}
              <div>
                <label className="text-xs text-zinc-500 block mb-1.5">Reports To</label>
                <HierarchyBadge value={agent.hierarchy.reportsTo} />
              </div>

              {/* Escalates To */}
              <div>
                <label className="text-xs text-zinc-500 block mb-1.5">Escalates To</label>
                <HierarchyBadge value={agent.hierarchy.escalatesTo} />
              </div>

              {/* Can Delegate To */}
              <div>
                <label className="text-xs text-zinc-500 block mb-1.5">Can Delegate To</label>
                {agent.hierarchy.canDelegate && agent.hierarchy.canDelegate.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {agent.hierarchy.canDelegate.map((d) => (
                      <HierarchyBadge key={d} value={d} />
                    ))}
                  </div>
                ) : (
                  <span className="text-xs text-zinc-600">None</span>
                )}
              </div>
            </div>
          </div>
        )}

        {/* D. System Prompt Card */}
        {prompt && (
          <div className="bg-zinc-900 border border-white/5 rounded-lg p-5">
            <button
              onClick={() => setPromptOpen(!promptOpen)}
              className="flex items-center gap-3 w-full text-left"
            >
              <span className="text-zinc-500 text-xs">{promptOpen ? "\u25BC" : "\u25B6"}</span>
              <h2 className="text-sm font-medium text-zinc-300">System Prompt</h2>
              <span className={`px-2 py-0.5 rounded text-xs font-medium ${PROMPT_TYPE_COLORS[prompt.type] || ""}`}>
                {prompt.type}
              </span>
              <span className="text-xs text-zinc-600 ml-auto">{prompt.source}</span>
            </button>
            {promptOpen && (
              <div className="mt-4 space-y-3">
                <pre className="bg-zinc-950 border border-white/5 rounded p-4 text-xs text-zinc-300 overflow-x-auto whitespace-pre-wrap max-h-80 overflow-y-auto font-mono leading-relaxed">
                  {prompt.prompt}
                </pre>
                {prompt.dynamicNote && (
                  <div className="flex items-start gap-2 px-3 py-2 bg-blue-500/5 border border-blue-500/10 rounded">
                    <span className="text-blue-400 text-xs font-medium shrink-0">Dynamic:</span>
                    <span className="text-xs text-blue-300">{prompt.dynamicNote}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* E. Activity & Performance Card */}
        <div className="bg-zinc-900 border border-white/5 rounded-lg p-5 space-y-5">
          <h2 className="text-sm font-medium text-zinc-300">Activity (7 days)</h2>

          {/* Stat Cards */}
          {activity && (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <StatCard label="Total Tasks" value={String(activity.stats.totalTasks)} />
              <StatCard label="Completed" value={String(activity.stats.completed)} color="text-emerald-400" />
              <StatCard label="Failed" value={String(activity.stats.failed)} color={activity.stats.failed > 0 ? "text-red-400" : undefined} />
              <StatCard label="Total Cost" value={`$${activity.stats.totalCostUsd.toFixed(3)}`} />
              <StatCard
                label="Last Active"
                value={activity.stats.lastActive ? timeAgo(activity.stats.lastActive) : "Never"}
              />
            </div>
          )}

          {/* Recent Tasks */}
          {activity && activity.recentTasks.length > 0 && (
            <div>
              <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-2">Recent Tasks</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-white/5 text-zinc-500 uppercase tracking-wider">
                      <th className="text-left px-3 py-2 font-medium">Title</th>
                      <th className="text-left px-3 py-2 font-medium">Status</th>
                      <th className="text-right px-3 py-2 font-medium">Cost</th>
                      <th className="text-right px-3 py-2 font-medium">Created</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {activity.recentTasks.map((task) => (
                      <tr key={task.id} className="hover:bg-white/[0.02]">
                        <td className="px-3 py-2 text-zinc-300 max-w-xs truncate">{task.title || task.id.slice(0, 8)}</td>
                        <td className="px-3 py-2">
                          <span className={STATUS_COLORS[task.status] || "text-zinc-400"}>{task.status}</span>
                        </td>
                        <td className="px-3 py-2 text-right text-zinc-400">
                          {task.cost_usd ? `$${parseFloat(task.cost_usd).toFixed(4)}` : "-"}
                        </td>
                        <td className="px-3 py-2 text-right text-zinc-500">
                          {new Date(task.created_at).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activity && activity.recentTasks.length === 0 && (
            <div className="text-center text-zinc-600 text-xs py-4">No tasks in the last 7 days</div>
          )}
        </div>

        {/* Config Changelog */}
        {changelog.length > 0 && (
          <div className="bg-zinc-900 border border-white/5 rounded-lg p-5">
            <h2 className="text-sm font-medium text-zinc-300 mb-3">Config Changes</h2>
            <div className="space-y-2">
              {changelog.map((entry, i) => (
                <div key={i} className="flex items-center gap-3 text-xs">
                  <span className="text-zinc-600 w-36 shrink-0">
                    {new Date(entry.timestamp).toLocaleString()}
                  </span>
                  <span className="text-zinc-400">{entry.boardUser}</span>
                  <span className="text-zinc-300 font-mono">
                    {Object.entries(entry.changes).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// --- Helper Components ---

function StatCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-zinc-950 border border-white/5 rounded-lg p-3">
      <div className="text-xs text-zinc-500 mb-1">{label}</div>
      <div className={`text-sm font-medium ${color || "text-zinc-200"}`}>{value}</div>
    </div>
  );
}

function HierarchyBadge({ value }: { value?: string }) {
  if (!value) return <span className="text-xs text-zinc-600">None</span>;

  if (value === "board") {
    return (
      <span className="inline-flex px-2 py-0.5 rounded text-xs font-medium bg-amber-500/20 text-amber-300 border border-amber-500/20">
        Board
      </span>
    );
  }

  return (
    <Link
      href={`/agents/${encodeURIComponent(value)}`}
      className="inline-flex px-2 py-0.5 rounded text-xs font-medium bg-zinc-800 text-zinc-300 border border-white/10 hover:bg-zinc-700 hover:text-zinc-100 transition-colors"
    >
      {value}
    </Link>
  );
}

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}
