"use client";

import { useAgentActivity, type AgentTier } from "@/contexts/AgentActivityContext";
import { AgentTierBadge } from "./AgentStatusBadge";

// ── Tier order matches SPEC §2 hierarchy ──────────────────────────────────────

const TIER_ORDER: AgentTier[] = [
  "strategist",
  "architect",
  "orchestrator",
  "reviewer",
  "executor",
  "utility",
  "external",
];

// ── Per-tier stats derived from live events ───────────────────────────────────

interface TierStats {
  tier: AgentTier;
  active: number;   // assigned | in_progress
  review: number;
  blocked: number;  // failed | blocked | timed_out
  completed: number;
  agentCount: number;
}

function deriveTierStats(
  events: ReturnType<typeof useAgentActivity>["state"]["events"],
): Map<AgentTier, TierStats> {
  // Most recent event per agentId — reflects current agent state
  const agentLatest = new Map<string, (typeof events)[0]>();
  for (const event of events) {
    if (!agentLatest.has(event.agentId)) {
      agentLatest.set(event.agentId, event);
    }
  }

  const stats = new Map<AgentTier, TierStats>();

  for (const [, event] of agentLatest) {
    const { tier, toState } = event;
    if (!stats.has(tier)) {
      stats.set(tier, { tier, active: 0, review: 0, blocked: 0, completed: 0, agentCount: 0 });
    }
    const s = stats.get(tier)!;
    s.agentCount++;
    if (toState === "assigned" || toState === "in_progress") s.active++;
    else if (toState === "review") s.review++;
    else if (toState === "failed" || toState === "blocked" || toState === "timed_out") s.blocked++;
    else if (toState === "completed") s.completed++;
  }

  return stats;
}

// ── Tier card ─────────────────────────────────────────────────────────────────

function TierCard({ stats }: { stats: TierStats }) {
  const hasBlocker = stats.blocked > 0;
  const isActive = stats.active > 0 || stats.review > 0;

  return (
    <div
      className={`rounded-lg p-3 border transition-colors ${
        hasBlocker
          ? "border-red-500/30 bg-red-500/5"
          : isActive
            ? "border-yellow-500/20 bg-yellow-500/5"
            : "border-white/5 bg-surface-raised"
      }`}
      role="group"
      aria-label={`${stats.tier} tier: ${stats.agentCount} agents`}
    >
      <AgentTierBadge tier={stats.tier} size="xs" />

      <div className="mt-2 space-y-0.5">
        {stats.active > 0 && (
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-zinc-500">active</span>
            <span className="text-yellow-400 font-medium tabular-nums">{stats.active}</span>
          </div>
        )}
        {stats.review > 0 && (
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-zinc-500">review</span>
            <span className="text-purple-400 font-medium tabular-nums">{stats.review}</span>
          </div>
        )}
        {stats.blocked > 0 && (
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-zinc-500">blocked</span>
            <span className="text-red-400 font-medium tabular-nums">{stats.blocked}</span>
          </div>
        )}
        {stats.active === 0 && stats.review === 0 && stats.blocked === 0 && (
          <div className="text-[10px] text-zinc-600">idle</div>
        )}
      </div>
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

interface AgentTierStatusGridProps {
  className?: string;
}

export function AgentTierStatusGrid({ className = "" }: AgentTierStatusGridProps) {
  const { state } = useAgentActivity();

  if (!state.isLoaded) {
    return (
      <div className={`space-y-2 ${className}`}>
        <div className="h-3 w-20 rounded bg-zinc-800 animate-pulse" />
        <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-7 gap-2">
          {TIER_ORDER.map((t) => (
            <div
              key={t}
              className="h-16 rounded-lg bg-surface-raised animate-pulse border border-white/5"
              aria-hidden="true"
            />
          ))}
        </div>
      </div>
    );
  }

  const tierStats = deriveTierStats(state.events);
  const activeTiers = TIER_ORDER.filter((t) => tierStats.has(t));

  if (activeTiers.length === 0) return null;

  return (
    <div className={`space-y-2 ${className}`} role="region" aria-label="Agent tier status">
      <h2 className="text-xs font-medium text-zinc-500 uppercase tracking-wide">
        Agent Tiers
      </h2>
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
        {activeTiers.map((tier) => (
          <TierCard key={tier} stats={tierStats.get(tier)!} />
        ))}
      </div>
    </div>
  );
}
