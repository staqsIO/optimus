"use client";

/**
 * OptimusMcpPanel — External agent status cards for the Agent Hub config tab.
 * Shows Optimus MCP instances with online/offline state, machine info, and quick actions.
 */

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { opsFetch } from "@/lib/ops-api";

interface AgentRuntimeStatus {
  online: boolean;
  enabled: boolean;
  status: string;
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

interface AgentConfig {
  id: string;
  type: string;
  description?: string;
  model: string;
  [key: string]: unknown;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function displayName(agentId: string, description?: string): string {
  if (description) return description;
  // nemoclaw-ecgang -> Optimus MCP (ecgang)
  const match = agentId.match(/^nemoclaw-(.+)$/);
  if (match) return `Optimus MCP (${match[1]})`;
  return agentId;
}

export default function OptimusMcpPanel() {
  const [externalAgents, setExternalAgents] = useState<
    { id: string; config: AgentConfig; status: AgentRuntimeStatus }[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [configRes, statusRes] = await Promise.all([
      opsFetch<{ agents: Record<string, AgentConfig> }>("/api/agents/config"),
      opsFetch<{ statuses: Record<string, AgentRuntimeStatus> }>("/api/agents/status"),
    ]);
    if (!configRes || !statusRes) {
      setLoading(false);
      return;
    }

    const externals: typeof externalAgents = [];
    for (const [id, agent] of Object.entries(configRes.agents)) {
      if (agent.type === "external") {
        externals.push({
          id,
          config: { ...agent, id },
          status: statusRes.statuses[id] || {
            online: false,
            enabled: false,
            status: "offline",
            tier: null,
            subTier: null,
            model: null,
            lastSeen: null,
            lastTaskAt: null,
            currentTask: null,
            pid: null,
            machineName: null,
            machineArch: null,
            clientVersion: null,
          },
        });
      }
    }
    setExternalAgents(externals);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 15_000);
    return () => clearInterval(interval);
  }, [load]);

  async function copyLaunchCmd(agentId: string) {
    const cmd = `claude --mcp-config ~/.claude/optimus-mcp.json`;
    await navigator.clipboard.writeText(cmd);
    setCopied(agentId);
    setTimeout(() => setCopied(null), 2000);
  }

  if (loading) return null;
  if (externalAgents.length === 0) return null;

  return (
    <section className="mb-8">
      <h2 className="text-lg font-medium text-zinc-300 mb-3">Optimus MCP Instances</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {externalAgents.map(({ id, config, status }) => {
          const isOnline = status.online;

          return (
            <div
              key={id}
              className="bg-zinc-900 border border-white/5 rounded-lg p-4 flex flex-col gap-3"
            >
              {/* Header */}
              <div className="flex items-start justify-between">
                <div>
                  <div className="text-sm font-medium text-zinc-200">
                    {displayName(id, config.description)}
                  </div>
                  <div className="text-xs text-zinc-500 font-mono">{id}</div>
                </div>
                <div className="flex items-center gap-1.5">
                  {isOnline ? (
                    <>
                      <span className="relative inline-block w-2 h-2">
                        <span className="absolute inset-0 rounded-full bg-emerald-400 animate-ping opacity-75" />
                        <span className="relative inline-block w-2 h-2 rounded-full bg-emerald-500" />
                      </span>
                      <span className="text-xs text-emerald-400">Online</span>
                    </>
                  ) : (
                    <>
                      <span className="inline-block w-2 h-2 rounded-full bg-zinc-600" />
                      <span className="text-xs text-zinc-500">Offline</span>
                    </>
                  )}
                </div>
              </div>

              {/* Machine info */}
              <div className="space-y-1 text-xs text-zinc-500">
                {isOnline && status.machineName && (
                  <div>
                    Machine: <span className="text-zinc-300">{status.machineName}</span>
                    {status.machineArch && (
                      <span className="text-zinc-600 ml-1">({status.machineArch})</span>
                    )}
                  </div>
                )}
                {isOnline && (
                  <div>
                    Since: <span className="text-zinc-400">{relativeTime(status.lastSeen)}</span>
                  </div>
                )}
                {!isOnline && status.lastSeen && (
                  <div>
                    Last seen: <span className="text-zinc-400">{relativeTime(status.lastSeen)}</span>
                  </div>
                )}
                {!isOnline && !status.lastSeen && (
                  <div className="text-zinc-600">Never connected</div>
                )}
                {status.model && (
                  <div>
                    Model: <span className="text-zinc-400 font-mono">{status.model}</span>
                  </div>
                )}
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2 pt-1 border-t border-white/5">
                <button
                  onClick={() => copyLaunchCmd(id)}
                  className="px-2.5 py-1 text-xs bg-zinc-800 text-zinc-400 rounded hover:bg-zinc-700 hover:text-zinc-200 transition-colors"
                >
                  {copied === id ? "Copied!" : "Copy Launch Cmd"}
                </button>
                <Link
                  href={`/agents/${encodeURIComponent(id)}`}
                  className="px-2.5 py-1 text-xs text-zinc-500 hover:text-zinc-200 transition-colors"
                >
                  View Detail &rarr;
                </Link>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
