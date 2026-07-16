"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import Link from "next/link";
import { opsFetch, opsPost } from "@/lib/ops-api";

interface LocalModel {
  provider: string;
  inputCostPer1M: number;
  outputCostPer1M: number;
  contextWindow: number;
  maxOutput: number;
}

interface RemoteModel {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  maxOutput: number;
  inputCostPer1M: number;
  outputCostPer1M: number;
  supportsTools: boolean;
  description: string;
}

interface ConfigData {
  agents: Record<string, { model: string }>;
  models: Record<string, LocalModel>;
}

const PROVIDER_COLORS: Record<string, string> = {
  anthropic: "bg-amber-500/20 text-amber-300",
  openai: "bg-emerald-500/20 text-emerald-300",
  google: "bg-blue-500/20 text-blue-300",
  meta: "bg-indigo-500/20 text-indigo-300",
  mistralai: "bg-orange-500/20 text-orange-300",
  deepseek: "bg-cyan-500/20 text-cyan-300",
  cohere: "bg-pink-500/20 text-pink-300",
};

function providerColor(p: string) {
  return PROVIDER_COLORS[p.toLowerCase()] || "bg-zinc-600/20 text-zinc-300";
}

export default function ModelsPage() {
  const [config, setConfig] = useState<ConfigData | null>(null);
  const [catalog, setCatalog] = useState<RemoteModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [providerFilter, setProviderFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "available">("all");
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  const loadConfig = useCallback(async () => {
    const data = await opsFetch<ConfigData>("/api/agents/config");
    if (data) setConfig(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  function showToast(msg: string, ok: boolean) {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 4000);
  }

  async function syncFromOpenRouter() {
    setSyncing(true);
    const result = await opsPost<{ models: RemoteModel[]; count: number }>("/api/models/sync");
    setSyncing(false);
    if (result.ok) {
      setCatalog(result.data.models);
      showToast(`Synced ${result.data.count} models from OpenRouter`, true);
    } else {
      showToast(result.error, false);
    }
  }

  async function addModel(model: RemoteModel) {
    setAdding(model.id);
    const result = await opsPost("/api/models/add", {
      modelId: model.id,
      provider: "openrouter",
      inputCostPer1M: model.inputCostPer1M,
      outputCostPer1M: model.outputCostPer1M,
      contextWindow: model.contextWindow,
      maxOutput: model.maxOutput,
    });
    setAdding(null);
    if (result.ok) {
      showToast(`Added ${model.id}`, true);
      loadConfig();
    } else {
      showToast(result.error, false);
    }
  }

  async function removeModel(modelId: string) {
    setRemoving(modelId);
    const result = await opsPost("/api/models/remove", { modelId });
    setRemoving(null);
    if (result.ok) {
      showToast(`Removed ${modelId}`, true);
      loadConfig();
    } else {
      showToast(result.error, false);
    }
  }

  // Merge local config models + remote catalog into one list
  const activeModelIds = useMemo(() => new Set(Object.keys(config?.models || {})), [config]);

  const agentUsage = useMemo(() => {
    const usage: Record<string, number> = {};
    if (!config) return usage;
    for (const agent of Object.values(config.agents)) {
      usage[agent.model] = (usage[agent.model] || 0) + 1;
    }
    return usage;
  }, [config]);

  // Combined model list: active (from config) + catalog (from sync)
  const allModels = useMemo(() => {
    const merged = new Map<string, { id: string; name: string; provider: string; contextWindow: number; maxOutput: number; inputCostPer1M: number; outputCostPer1M: number; supportsTools: boolean; description: string; active: boolean }>();

    // Add active models from config
    for (const [id, m] of Object.entries(config?.models || {})) {
      merged.set(id, {
        id,
        name: id,
        provider: m.provider,
        contextWindow: m.contextWindow,
        maxOutput: m.maxOutput,
        inputCostPer1M: m.inputCostPer1M,
        outputCostPer1M: m.outputCostPer1M,
        supportsTools: false,
        description: "",
        active: true,
      });
    }

    // Add catalog models (enrich active ones, add inactive ones)
    for (const m of catalog) {
      if (merged.has(m.id)) {
        const existing = merged.get(m.id)!;
        existing.name = m.name;
        existing.description = m.description;
        existing.supportsTools = m.supportsTools;
      } else {
        merged.set(m.id, { ...m, active: false });
      }
    }

    return Array.from(merged.values());
  }, [config, catalog]);

  // Filter + search
  const filtered = useMemo(() => {
    let list = allModels;

    if (statusFilter === "active") list = list.filter(m => m.active);
    if (statusFilter === "available") list = list.filter(m => !m.active);

    if (providerFilter !== "all") {
      list = list.filter(m => m.provider.toLowerCase() === providerFilter.toLowerCase());
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(m =>
        m.id.toLowerCase().includes(q) ||
        m.name.toLowerCase().includes(q) ||
        m.provider.toLowerCase().includes(q) ||
        m.description.toLowerCase().includes(q)
      );
    }

    return list;
  }, [allModels, search, providerFilter, statusFilter]);

  // Group by provider
  const grouped = useMemo(() => {
    const groups = new Map<string, typeof filtered>();
    for (const m of filtered) {
      const key = m.provider;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(m);
    }
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  // Unique providers for filter dropdown
  const providers = useMemo(() => {
    const set = new Set(allModels.map(m => m.provider));
    return Array.from(set).sort();
  }, [allModels]);

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <div className="text-zinc-500 text-sm">Loading models...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-200 p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Toast */}
        {toast && (
          <div className={`fixed top-16 right-6 z-50 px-4 py-2 rounded-lg text-sm font-medium shadow-lg animate-fade-in ${toast.ok ? "bg-emerald-600 text-white" : "bg-red-600 text-white"}`}>
            {toast.msg}
          </div>
        )}

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <Link href="/agents" className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors">
                Agents
              </Link>
              <span className="text-zinc-600">/</span>
              <h1 className="text-2xl font-semibold tracking-tight">Available Models</h1>
            </div>
            <p className="text-sm text-zinc-500">
              Configure AI models available in the platform
              {allModels.length > 0 && <span className="ml-2 text-zinc-600">({allModels.length} models)</span>}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={syncFromOpenRouter}
              disabled={syncing}
              className="flex items-center gap-2 px-4 py-2 bg-zinc-800 hover:bg-zinc-700 disabled:bg-zinc-800 disabled:opacity-50 text-zinc-200 text-sm font-medium rounded-lg transition-colors border border-white/10"
            >
              <span className={syncing ? "animate-spin" : ""}>&#x21BB;</span>
              {syncing ? "Syncing..." : "Sync from OpenRouter"}
            </button>
          </div>
        </div>

        {/* Search + Filters */}
        <div className="flex items-center gap-3">
          <div className="flex-1 relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 text-sm">&#x1F50D;</span>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search models by name, ID, or provider..."
              className="w-full pl-9 pr-3 py-2 bg-zinc-900 border border-white/10 rounded-lg text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-accent-bright"
            />
          </div>
          <select
            value={providerFilter}
            onChange={(e) => setProviderFilter(e.target.value)}
            className="bg-zinc-900 border border-white/10 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-accent-bright"
          >
            <option value="all">All Providers</option>
            {providers.map(p => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as "all" | "active" | "available")}
            className="bg-zinc-900 border border-white/10 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-accent-bright"
          >
            <option value="all">All Status</option>
            <option value="active">Active</option>
            <option value="available">Available</option>
          </select>
        </div>

        {/* Empty state */}
        {catalog.length === 0 && Object.keys(config?.models || {}).length === 0 && (
          <div className="bg-zinc-900 border border-white/5 rounded-lg p-12 text-center">
            <p className="text-zinc-400 text-sm mb-4">No models loaded yet. Sync the OpenRouter catalog to browse available models.</p>
            <button
              onClick={syncFromOpenRouter}
              disabled={syncing}
              className="px-4 py-2 bg-accent-bright/20 text-accent-bright text-sm font-medium rounded-lg hover:bg-accent-bright/30 transition-colors"
            >
              {syncing ? "Syncing..." : "Sync from OpenRouter"}
            </button>
          </div>
        )}

        {/* Grouped model tables */}
        {grouped.map(([provider, models]) => (
          <section key={provider}>
            <div className="flex items-center gap-2 mb-2">
              <span className={`px-2 py-0.5 rounded text-xs font-medium ${providerColor(provider)}`}>
                {provider}
              </span>
              <span className="text-xs text-zinc-500">{models.length}</span>
            </div>
            <div className="bg-zinc-900 border border-white/5 rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/5 text-xs text-zinc-500 uppercase tracking-wider">
                    <th className="text-left px-4 py-2.5 font-medium">Model ID</th>
                    <th className="text-left px-4 py-2.5 font-medium">Display Name</th>
                    <th className="text-right px-4 py-2.5 font-medium">Max Context</th>
                    <th className="text-right px-4 py-2.5 font-medium">Cost (In/Out per 1M)</th>
                    <th className="text-center px-4 py-2.5 font-medium">Features</th>
                    <th className="text-center px-4 py-2.5 font-medium">Status</th>
                    <th className="text-right px-4 py-2.5 font-medium w-28">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {models.map((m) => (
                    <tr key={m.id} className="hover:bg-white/[0.02] transition-colors">
                      <td className="px-4 py-2.5">
                        <span className="font-mono text-xs text-zinc-300">{m.id}</span>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="text-xs text-zinc-400">{m.name !== m.id ? m.name : ""}</span>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <span className="text-xs text-zinc-400">
                          {m.contextWindow > 0 ? `${(m.contextWindow / 1000).toFixed(0)}K` : "-"}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <span className="text-xs text-zinc-400">
                          ${m.inputCostPer1M.toFixed(2)} / ${m.outputCostPer1M.toFixed(2)}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        {m.supportsTools && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-500/20 text-blue-300">
                            Functions
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        {m.active ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-emerald-500/20 text-emerald-300">
                            Active
                            {agentUsage[m.id] ? ` (${agentUsage[m.id]})` : ""}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-zinc-600/20 text-zinc-400">
                            Available
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {m.active ? (
                          <button
                            onClick={() => removeModel(m.id)}
                            disabled={removing === m.id || !!agentUsage[m.id]}
                            title={agentUsage[m.id] ? `In use by ${agentUsage[m.id]} agent(s)` : "Remove from config"}
                            className="px-2 py-1 text-xs bg-red-500/10 text-red-400 rounded hover:bg-red-500/20 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                          >
                            {removing === m.id ? "..." : "Remove"}
                          </button>
                        ) : (
                          <button
                            onClick={() => addModel(m)}
                            disabled={adding === m.id}
                            className="px-2 py-1 text-xs bg-emerald-500/10 text-emerald-400 rounded hover:bg-emerald-500/20 transition-colors disabled:opacity-50"
                          >
                            {adding === m.id ? "..." : "Add"}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
