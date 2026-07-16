"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";

/* ── Agent Node ────────────────────────────────────────── */

export interface AgentNodeData {
  label: string;
  agentId: string;
  tier: string;
  model: string;
  initials: string;
  color: string;
  textColor: string;
  role: string;
  recentTasks: number;
  successRate: number | null;
  capabilities: string[];
  deployment?: string;
  activityStatus?: 'idle' | 'processing' | 'claimed';
  lastTaskTitle?: string;
  lastCompletedOutput?: string;  // "PR ready" / "Output available" / null
  currentCampaignId?: string;
  triageCount?: number;          // For issue-triage agent: recent triage count
  [key: string]: unknown;
}

export const AgentNode = memo(function AgentNode({ data, selected }: NodeProps) {
  const d = data as unknown as AgentNodeData;
  const pct = d.successRate;
  const healthColor = pct === null
    ? "border-zinc-600"
    : pct >= 90
      ? "border-emerald-500/60"
      : pct >= 70
        ? "border-amber-500/60"
        : "border-red-500/60";

  const healthGlow = pct === null
    ? ""
    : pct >= 90
      ? "shadow-[0_0_12px_rgba(16,185,129,0.15)]"
      : pct >= 70
        ? "shadow-[0_0_12px_rgba(245,158,11,0.15)]"
        : "shadow-[0_0_12px_rgba(239,68,68,0.15)]";

  const selectedRing = selected ? "ring-2 ring-accent/50 ring-offset-1 ring-offset-transparent" : "";

  const activityClass = d.activityStatus === "processing"
    ? "agent-node-processing"
    : d.activityStatus === "claimed"
      ? "agent-node-claimed"
      : "agent-node-idle";

  return (
    <div className={`relative bg-surface-raised border-2 ${healthColor} ${healthGlow} ${selectedRing} ${activityClass} rounded-xl px-4 py-3 min-w-[140px] transition-all hover:border-accent-bright/50 cursor-pointer`}>
      <Handle type="target" position={Position.Top} className="!bg-zinc-600 !border-zinc-500 !w-2 !h-2" />

      <div className="flex items-center gap-2.5">
        <div className={`w-8 h-8 ${d.color} rounded-full flex items-center justify-center text-white font-bold text-[10px] flex-shrink-0 relative`}>
          {d.initials}
          {d.activityStatus === "processing" && (
            <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-400 animate-ping" />
          )}
        </div>
        <div>
          <div className={`text-xs font-semibold ${d.textColor}`}>{d.label}</div>
          <div className="text-[9px] text-zinc-500">{d.role} &middot; {tierLabel(d.model)}</div>
        </div>
      </div>

      {/* Activity indicator — what the agent is doing right now */}
      {d.activityStatus === "processing" && d.lastTaskTitle && (
        <div className="mt-1.5 px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/20">
          <div className="text-[8px] text-emerald-400 truncate">{d.lastTaskTitle}</div>
        </div>
      )}

      {/* Output badge — agent has produced something ready for review */}
      {d.lastCompletedOutput && d.activityStatus !== "processing" && (
        <div className="mt-1.5 px-1.5 py-0.5 rounded bg-blue-500/10 border border-blue-500/20 flex items-center gap-1">
          <span className="text-[8px] text-blue-400">✓</span>
          <span className="text-[8px] text-blue-300 truncate">{d.lastCompletedOutput}</span>
        </div>
      )}

      {/* Triage count for issue-triage agent */}
      {d.triageCount != null && d.triageCount > 0 && (
        <div className="mt-1.5 px-1.5 py-0.5 rounded bg-violet-500/10 border border-violet-500/20">
          <span className="text-[8px] text-violet-300">{d.triageCount} triaged today</span>
        </div>
      )}

      {/* Stats bar */}
      <div className="flex items-center gap-2 mt-2 pt-2 border-t border-white/5">
        {d.recentTasks > 0 && (
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400">
            {d.recentTasks} tasks/7d
          </span>
        )}
        <span className={`text-[9px] px-1.5 py-0.5 rounded ${
          pct === null ? "bg-zinc-500/10 text-zinc-500" : pct >= 90 ? "bg-emerald-400/10 text-emerald-400" : pct >= 70 ? "bg-amber-400/10 text-amber-400" : "bg-red-400/10 text-red-400"
        }`}>
          {pct !== null ? `${pct}%` : "idle"}
        </span>
        {d.deployment && (
          <span className={`text-[7px] px-1 py-0.5 rounded ml-auto ${
            d.deployment === "runner" ? "bg-orange-500/10 text-orange-500" : "bg-sky-500/10 text-sky-500"
          }`}>
            {d.deployment === "runner" ? "local" : "cloud"}
          </span>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} className="!bg-zinc-600 !border-zinc-500 !w-2 !h-2" />
    </div>
  );
});

/* ── Source Channel Node ───────────────────────────────── */

export interface SourceNodeData {
  label: string;
  channel: string;
  icon: string;
  signalsToday: number;
  color: string;
  [key: string]: unknown;
}

export const SourceNode = memo(function SourceNode({ data, selected }: NodeProps) {
  const d = data as unknown as SourceNodeData;
  const selectedRing = selected ? "ring-2 ring-accent/50" : "";
  return (
    <div className={`relative bg-surface-raised border border-white/10 rounded-xl px-4 py-3 min-w-[130px] hover:border-white/20 transition-all cursor-pointer ${selectedRing}`}>
      <Handle type="source" position={Position.Bottom} className="!bg-zinc-600 !border-zinc-500 !w-2 !h-2" />

      <div className="flex items-center gap-2">
        <span className="text-lg">{d.icon}</span>
        <div>
          <div className="text-xs font-semibold text-zinc-200">{d.label}</div>
          <div className="text-[9px] text-zinc-500">{d.channel}</div>
        </div>
      </div>

      {d.signalsToday > 0 && (
        <div className="mt-2 pt-2 border-t border-white/5">
          <span className={`text-[9px] px-1.5 py-0.5 rounded ${d.color}`}>
            {d.signalsToday} today
          </span>
        </div>
      )}
    </div>
  );
});

/* ── Routing Tier Node ─────────────────────────────────── */

export interface TierNodeData {
  label: string;
  tier: number;
  description: string;
  color: string;
  count: number;
  [key: string]: unknown;
}

export const TierNode = memo(function TierNode({ data, selected }: NodeProps) {
  const d = data as unknown as TierNodeData;
  const selectedRing = selected ? "ring-2 ring-accent/50" : "";
  return (
    <div className={`relative bg-surface-raised border border-white/10 rounded-lg px-4 py-2.5 min-w-[160px] hover:border-white/20 transition-all cursor-pointer ${selectedRing}`}>
      <Handle type="target" position={Position.Top} className="!bg-zinc-600 !border-zinc-500 !w-2 !h-2" />

      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${d.color}`} />
            <span className="text-xs font-semibold text-zinc-200">{d.label}</span>
          </div>
          <div className="text-[9px] text-zinc-500 mt-0.5">{d.description}</div>
        </div>
        {d.count > 0 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-zinc-400">
            {d.count}
          </span>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} className="!bg-zinc-600 !border-zinc-500 !w-2 !h-2" />
    </div>
  );
});

/* ── Spec Section Node ─────────────────────────────────── */

export interface SpecNodeData {
  label: string;
  section: string;
  status: string;
  references: number;
  [key: string]: unknown;
}

export const SpecNode = memo(function SpecNode({ data, selected }: NodeProps) {
  const d = data as unknown as SpecNodeData;
  const statusColor = d.status === "complete"
    ? "bg-emerald-500"
    : d.status === "partial"
      ? "bg-amber-500"
      : "bg-zinc-600";
  const selectedRing = selected ? "ring-2 ring-accent/50" : "";

  return (
    <div className={`relative bg-surface-raised border border-white/10 rounded-lg px-3 py-2 min-w-[120px] hover:border-accent/30 transition-all cursor-pointer ${selectedRing}`}>
      <Handle type="target" position={Position.Top} className="!bg-zinc-600 !border-zinc-500 !w-1.5 !h-1.5" />

      <div className="flex items-center gap-1.5">
        <span className={`w-1.5 h-1.5 rounded-full ${statusColor} flex-shrink-0`} />
        <span className="text-[10px] font-medium text-zinc-300 truncate">{d.label}</span>
      </div>
      <div className="text-[8px] text-zinc-600 mt-0.5">{d.section}</div>

      <Handle type="source" position={Position.Bottom} className="!bg-zinc-600 !border-zinc-500 !w-1.5 !h-1.5" />
    </div>
  );
});

/* ── Destination Node (Briefing / Dashboard) ───────────── */

export interface DestinationNodeData {
  label: string;
  icon: string;
  description: string;
  [key: string]: unknown;
}

export const DestinationNode = memo(function DestinationNode({ data, selected }: NodeProps) {
  const d = data as unknown as DestinationNodeData;
  const selectedRing = selected ? "ring-2 ring-accent/50" : "";
  return (
    <div className={`relative bg-surface-raised border border-accent/20 rounded-xl px-4 py-3 min-w-[140px] hover:border-accent/40 transition-all cursor-pointer ${selectedRing}`}>
      <Handle type="target" position={Position.Top} className="!bg-accent-dim !border-accent !w-2 !h-2" />

      <div className="flex items-center gap-2">
        <span className="text-lg">{d.icon}</span>
        <div>
          <div className="text-xs font-semibold text-accent-bright">{d.label}</div>
          <div className="text-[9px] text-zinc-500">{d.description}</div>
        </div>
      </div>
    </div>
  );
});

/* ── System Node (major subsystem) ─────────────────────── */

export interface SystemNodeData {
  label: string;
  description: string;
  icon: string;
  color: string;
  badges?: string[];
  configGates?: {
    linear?: {
      triggers: Array<{ type: string; value: string }>;
      watchedTeams: string[];
      watchedProjects: string[];
    } | null;
    github?: {
      repos: string[];
      autoFixLabels: string[];
      watchedEvents: string[];
      defaultAgent: string | null;
    } | null;
  };
  [key: string]: unknown;
}

export const SystemNode = memo(function SystemNode({ data, selected }: NodeProps) {
  const d = data as unknown as SystemNodeData;
  const selectedRing = selected ? "ring-2 ring-accent/50" : "";
  const isConfigGate = !!d.configGates;

  return (
    <div className={`arch-system-node relative bg-surface-raised rounded-xl px-4 py-3 min-w-[160px] ${isConfigGate ? "max-w-[240px]" : "max-w-[200px]"} hover:border-accent-bright/40 transition-all cursor-pointer ${selectedRing}`}>
      <Handle type="target" position={Position.Top} className="!bg-zinc-600 !border-zinc-500 !w-2 !h-2" />
      <div className="flex items-center gap-2">
        <span className="text-base flex-shrink-0">{d.icon}</span>
        <div className="min-w-0">
          <div className="text-[11px] font-semibold text-zinc-200 truncate">{d.label}</div>
          <div className="text-[8px] text-zinc-500 leading-tight">{d.description}</div>
        </div>
      </div>

      {/* Config Gates detail view — show triggers and watched scope */}
      {isConfigGate && d.configGates ? (
        <div className="mt-2 pt-1.5 border-t border-white/5 space-y-1.5">
          {d.configGates.linear && (
            <div>
              <div className="text-[7px] font-medium text-violet-400 mb-0.5">Linear triggers</div>
              <div className="flex flex-wrap gap-1">
                {d.configGates.linear.triggers.map((t, i) => (
                  <span key={i} className="text-[7px] px-1 py-0.5 rounded bg-violet-500/10 text-violet-400">
                    {t.type === "assignee" ? `${t.value}` : `"${t.value}"`}
                  </span>
                ))}
              </div>
              {d.configGates.linear.watchedTeams.length > 0 && (
                <div className="text-[6px] text-zinc-600 mt-0.5">
                  Teams: {d.configGates.linear.watchedTeams.join(", ")}
                </div>
              )}
            </div>
          )}
          {d.configGates.github && (
            <div>
              <div className="text-[7px] font-medium text-zinc-400 mb-0.5">GitHub triggers</div>
              <div className="flex flex-wrap gap-1">
                {d.configGates.github.autoFixLabels.map((l, i) => (
                  <span key={i} className="text-[7px] px-1 py-0.5 rounded bg-zinc-500/10 text-zinc-400">
                    &quot;{l}&quot; label
                  </span>
                ))}
                {d.configGates.github.watchedEvents.map((e, i) => (
                  <span key={i} className="text-[7px] px-1 py-0.5 rounded bg-zinc-500/10 text-zinc-500">
                    {e}
                  </span>
                ))}
              </div>
              {d.configGates.github.repos.length > 0 && (
                <div className="text-[6px] text-zinc-600 mt-0.5">
                  {d.configGates.github.repos.length} repos watched
                </div>
              )}
            </div>
          )}
        </div>
      ) : d.badges && d.badges.length > 0 ? (
        <div className="flex flex-wrap gap-1 mt-2 pt-1.5 border-t border-white/5">
          {d.badges.map((b, i) => (
            <span key={i} className={`text-[7px] px-1 py-0.5 rounded ${d.color}`}>{b}</span>
          ))}
        </div>
      ) : null}

      <Handle type="source" position={Position.Bottom} className="!bg-zinc-600 !border-zinc-500 !w-2 !h-2" />
    </div>
  );
});

/* ── Router Node (Orchestrator routing hub) ──────────── */

export interface RouterNodeData {
  label: string;
  description: string;
  icon: string;
  agentId: string;
  model: string;
  recentTasks: number;
  successRate: number | null;
  rules: Array<{ label: string; target: string; color: string; terminal?: boolean }>;
  fallback?: string;
  [key: string]: unknown;
}

export const RouterNode = memo(function RouterNode({ data, selected }: NodeProps) {
  const d = data as unknown as RouterNodeData;
  const selectedRing = selected ? "ring-2 ring-blue-400/50" : "";
  const pct = d.successRate;

  return (
    <div className={`relative bg-surface-raised border-2 border-blue-500/30 rounded-xl px-4 py-3 min-w-[220px] max-w-[280px] hover:border-blue-400/50 transition-all cursor-pointer ${selectedRing}`}>
      <Handle type="target" position={Position.Top} className="!bg-blue-500 !border-blue-400 !w-2.5 !h-2.5" />

      <div className="flex items-center gap-2 mb-2">
        <div className="w-7 h-7 bg-blue-500 rounded-lg flex items-center justify-center text-white font-bold text-[9px] flex-shrink-0">
          OR
        </div>
        <div className="min-w-0">
          <div className="text-[11px] font-bold text-blue-300">{d.label}</div>
          <div className="text-[8px] text-zinc-500">{d.description} &middot; {d.model}</div>
        </div>
      </div>

      {/* Stats */}
      <div className="flex items-center gap-2 mb-2 pb-2 border-b border-white/5">
        {d.recentTasks > 0 && (
          <span className="text-[8px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400">
            {d.recentTasks} tasks/7d
          </span>
        )}
        <span className={`text-[8px] px-1.5 py-0.5 rounded ${
          pct === null ? "bg-zinc-500/10 text-zinc-500" : pct >= 90 ? "bg-emerald-400/10 text-emerald-400" : "bg-amber-400/10 text-amber-400"
        }`}>
          {pct !== null ? `${pct}%` : "idle"}
        </span>
      </div>

      {/* Routing rules */}
      <div className="text-[7px] font-medium text-zinc-500 mb-1 tracking-wider">ROUTING RULES</div>
      <div className="space-y-0.5">
        {d.rules.map((rule, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${rule.color}`} />
            <span className="text-[7px] text-zinc-400 flex-1 truncate">{rule.label}</span>
            <span className={`text-[7px] flex-shrink-0 ${rule.terminal ? "text-zinc-700 italic" : "text-zinc-600"}`}>
              {rule.terminal ? "terminal" : `\u2192 ${rule.target}`}
            </span>
          </div>
        ))}
        {d.fallback && (
          <div className="flex items-center gap-1.5 pt-1 mt-0.5 border-t border-white/5">
            <span className="w-1.5 h-1.5 rounded-full bg-zinc-600 flex-shrink-0" />
            <span className="text-[7px] text-zinc-500 italic">fallback: LLM \u2192 {d.fallback}</span>
          </div>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} className="!bg-blue-500 !border-blue-400 !w-2.5 !h-2.5" />
    </div>
  );
});

/* ── Service Node (deployable service) ────────────────── */

export interface ServiceNodeData {
  label: string;
  description: string;
  icon: string;
  port?: number;
  stack?: string;
  features?: string[];
  [key: string]: unknown;
}

export const ServiceNode = memo(function ServiceNode({ data, selected }: NodeProps) {
  const d = data as unknown as ServiceNodeData;
  const selectedRing = selected ? "ring-2 ring-accent/50" : "";
  return (
    <div className={`arch-service-node relative bg-surface-raised border border-accent/20 rounded-xl px-4 py-3 min-w-[160px] max-w-[200px] hover:border-accent/40 transition-all cursor-pointer ${selectedRing}`}>
      <Handle type="target" position={Position.Top} className="!bg-accent-dim !border-accent !w-2 !h-2" />
      <div className="flex items-center gap-2">
        <span className="text-base flex-shrink-0">{d.icon}</span>
        <div className="min-w-0">
          <div className="text-[11px] font-semibold text-accent-bright truncate">{d.label}</div>
          <div className="text-[8px] text-zinc-500">{d.description}</div>
        </div>
      </div>
      <div className="flex items-center gap-1.5 mt-2 pt-1.5 border-t border-white/5">
        {d.port && (
          <span className="text-[7px] px-1.5 py-0.5 rounded bg-accent/10 text-accent-bright font-mono">:{d.port}</span>
        )}
        {d.stack && (
          <span className="text-[7px] px-1.5 py-0.5 rounded bg-white/5 text-zinc-400">{d.stack}</span>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-accent-dim !border-accent !w-2 !h-2" />
    </div>
  );
});

/* ── Store Node (database/cache) ──────────────────────── */

export interface StoreNodeData {
  label: string;
  description: string;
  icon: string;
  schemas?: string[];
  status?: "connected" | "fallback" | "degraded" | "offline";
  [key: string]: unknown;
}

export const StoreNode = memo(function StoreNode({ data, selected }: NodeProps) {
  const d = data as unknown as StoreNodeData;
  const statusColor = d.status === "connected" ? "bg-emerald-500" : d.status === "degraded" ? "bg-amber-500" : d.status === "fallback" ? "bg-amber-500" : "bg-red-500";
  const statusLabel = d.status === "connected" ? "Connected" : d.status === "degraded" ? "Learning disabled" : d.status === "fallback" ? "Fallback" : "Offline";
  const selectedRing = selected ? "ring-2 ring-cyan-400/50" : "";
  return (
    <div className={`arch-store-node relative bg-surface-raised rounded-xl px-4 py-3 min-w-[160px] max-w-[200px] hover:border-cyan-400/40 transition-all cursor-pointer ${selectedRing}`}>
      <Handle type="target" position={Position.Top} className="!bg-cyan-600 !border-cyan-500 !w-2 !h-2" />
      <div className="flex items-center gap-2">
        <span className="text-base flex-shrink-0">{d.icon}</span>
        <div className="min-w-0">
          <div className="text-[11px] font-semibold text-cyan-300 truncate">{d.label}</div>
          <div className="text-[8px] text-zinc-500">{d.description}</div>
        </div>
      </div>
      <div className="flex items-center gap-1.5 mt-2 pt-1.5 border-t border-white/5">
        {d.status && (
          <div className="flex items-center gap-1">
            <span className={`w-1.5 h-1.5 rounded-full ${statusColor}`} />
            <span className="text-[7px] text-zinc-500">{statusLabel}</span>
          </div>
        )}
        {d.schemas && (
          <span className="text-[7px] px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-400">{d.schemas.length} schemas</span>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-cyan-600 !border-cyan-500 !w-2 !h-2" />
    </div>
  );
});

/* ── Governance Node (Board, SPEC, Principles) ────────── */

export interface GovernanceNodeData {
  label: string;
  description: string;
  icon: string;
  subtitle?: string;
  [key: string]: unknown;
}

export const GovernanceNode = memo(function GovernanceNode({ data, selected }: NodeProps) {
  const d = data as unknown as GovernanceNodeData;
  const selectedRing = selected ? "ring-2 ring-amber-400/50" : "";
  return (
    <div className={`arch-governance-node relative bg-surface-raised rounded-xl px-4 py-3 min-w-[160px] max-w-[220px] hover:border-amber-400/60 transition-all cursor-pointer ${selectedRing}`}>
      <Handle type="target" position={Position.Top} className="!bg-amber-600 !border-amber-500 !w-2 !h-2" />
      <div className="flex items-center gap-2">
        <span className="text-base flex-shrink-0">{d.icon}</span>
        <div className="min-w-0">
          <div className="text-[11px] font-bold text-amber-300 truncate">{d.label}</div>
          <div className="text-[8px] text-amber-500/70">{d.description}</div>
        </div>
      </div>
      {d.subtitle && (
        <div className="mt-1.5 pt-1.5 border-t border-amber-500/10">
          <div className="text-[7px] text-amber-600/60 italic">{d.subtitle}</div>
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="!bg-amber-600 !border-amber-500 !w-2 !h-2" />
    </div>
  );
});

/* ── Integration Node (external service) ──────────────── */

export interface IntegrationNodeData {
  label: string;
  authMethod: string;
  icon: string;
  color: string;
  signalsToday?: number;
  [key: string]: unknown;
}

export const IntegrationNode = memo(function IntegrationNode({ data, selected }: NodeProps) {
  const d = data as unknown as IntegrationNodeData;
  const selectedRing = selected ? "ring-2 ring-accent/50" : "";
  return (
    <div className={`arch-integration-node relative bg-surface-raised border border-white/10 rounded-lg px-3 py-2.5 min-w-[120px] hover:border-white/20 transition-all cursor-pointer ${selectedRing}`}>
      <div className="flex items-center gap-2">
        <span className="text-sm flex-shrink-0">{d.icon}</span>
        <div className="min-w-0">
          <div className="text-[10px] font-semibold text-zinc-200 truncate">{d.label}</div>
          <div className="text-[7px] text-zinc-600">{d.authMethod}</div>
        </div>
      </div>
      {d.signalsToday !== undefined && d.signalsToday > 0 && (
        <div className="mt-1.5 pt-1 border-t border-white/5">
          <span className={`text-[7px] px-1 py-0.5 rounded ${d.color}`}>{d.signalsToday} today</span>
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="!bg-zinc-600 !border-zinc-500 !w-1.5 !h-1.5" />
    </div>
  );
});

/* ── Helpers ───────────────────────────────────────────── */

function tierLabel(model: string): string {
  return model || "Unknown";
}

export const nodeTypes = {
  agent: AgentNode,
  router: RouterNode,
  source: SourceNode,
  tier: TierNode,
  spec: SpecNode,
  destination: DestinationNode,
  system: SystemNode,
  service: ServiceNode,
  store: StoreNode,
  governance: GovernanceNode,
  integration: IntegrationNode,
};
