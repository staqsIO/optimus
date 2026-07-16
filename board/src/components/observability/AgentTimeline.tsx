"use client";

import { useMemo } from "react";
import { useAgentActivity, type AgentTier, type AgentActivityEvent } from "@/contexts/AgentActivityContext";
import { AgentTierBadge } from "./AgentStatusBadge";

// ── Tier ordering (highest authority first) ────────────────────────────────────

const TIER_ORDER: AgentTier[] = [
  "strategist",
  "architect",
  "orchestrator",
  "reviewer",
  "executor",
  "utility",
  "external",
  "unknown",
];

// ── Status dot colors (matches AgentStatusBadge) ───────────────────────────────

const DOT_COLORS: Record<string, string> = {
  created:     "bg-zinc-400",
  assigned:    "bg-blue-400",
  in_progress: "bg-yellow-400",
  review:      "bg-purple-400",
  completed:   "bg-green-400",
  failed:      "bg-red-400",
  blocked:     "bg-orange-400",
  timed_out:   "bg-red-300",
  cancelled:   "bg-zinc-600",
};

// ── Time window options ────────────────────────────────────────────────────────

const WINDOWS = [
  { label: "15m", ms: 15 * 60 * 1000 },
  { label: "1h",  ms: 60 * 60 * 1000 },
  { label: "6h",  ms: 6 * 60 * 60 * 1000 },
  { label: "24h", ms: 24 * 60 * 60 * 1000 },
] as const;

// ── Lane for a single agent ────────────────────────────────────────────────────

interface LaneProps {
  agentId: string;
  tier: AgentTier;
  events: AgentActivityEvent[];
  windowMs: number;
  nowMs: number;
}

function AgentLane({ agentId, tier, events, windowMs, nowMs }: LaneProps) {
  const shortId = agentId.split("-").slice(-2).join("-") || agentId;

  return (
    <div
      className="flex items-center gap-2 py-1.5 border-b border-white/5 group"
      role="row"
      aria-label={`Agent ${agentId}`}
    >
      {/* Agent label */}
      <div className="w-32 flex-shrink-0 flex flex-col gap-0.5 overflow-hidden">
        <AgentTierBadge tier={tier} size="xs" />
        <span
          className="text-[10px] text-zinc-500 truncate group-hover:text-zinc-300 transition-colors"
          title={agentId}
        >
          {shortId}
        </span>
      </div>

      {/* Timeline track */}
      <div
        className="relative flex-1 h-5 bg-zinc-900/50 rounded overflow-hidden"
        role="img"
        aria-label={`${events.length} events in window`}
      >
        {events.map((ev) => {
          const age = nowMs - new Date(ev.timestamp).getTime();
          if (age < 0 || age > windowMs) return null;

          // Position: 0% = oldest (left), 100% = newest (right)
          const pct = ((windowMs - age) / windowMs) * 100;
          const dotColor = DOT_COLORS[ev.toState] || "bg-zinc-400";

          return (
            <button
              key={ev.id}
              className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2.5 h-2.5 rounded-full ${dotColor} opacity-80 hover:opacity-100 hover:scale-150 transition-all cursor-pointer border border-black/20`}
              style={{ left: `${pct}%` }}
              aria-label={`${ev.fromState ?? "new"} → ${ev.toState} at ${new Date(ev.timestamp).toLocaleTimeString()}: ${ev.workItemTitle}`}
              title={`${ev.toState} — ${ev.workItemTitle}\n${new Date(ev.timestamp).toLocaleTimeString()}`}
            />
          );
        })}
      </div>

      {/* Event count */}
      <span className="text-[10px] text-zinc-600 w-6 text-right flex-shrink-0">
        {events.length}
      </span>
    </div>
  );
}

// ── Props ──────────────────────────────────────────────────────────────────────

interface AgentTimelineProps {
  /** Time window in minutes (overrides dropdown) */
  windowMs?: number;
  className?: string;
}

// ── Component ──────────────────────────────────────────────────────────────────

export function AgentTimeline({ windowMs: windowMsProp, className = "" }: AgentTimelineProps) {
  const { filteredEvents, state } = useAgentActivity();

  // Local state: selected window index (default to 15m)
  const [windowIdx, setWindowIdx] = [0, () => {}]; // simplified — use prop or default 15m
  const windowMs = windowMsProp ?? WINDOWS[0].ms;

  const nowMs = Date.now();

  // Group events by agent, then sort lanes by tier
  const lanes = useMemo(() => {
    const byAgent = new Map<string, { tier: AgentTier; events: AgentActivityEvent[] }>();

    for (const ev of filteredEvents) {
      const age = nowMs - new Date(ev.timestamp).getTime();
      if (age > windowMs) continue;

      if (!byAgent.has(ev.agentId)) {
        byAgent.set(ev.agentId, { tier: ev.tier, events: [] });
      }
      byAgent.get(ev.agentId)!.events.push(ev);
    }

    // Sort: by tier order, then by agent ID
    return [...byAgent.entries()]
      .sort(([aId, a], [bId, b]) => {
        const tierDiff = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier);
        return tierDiff !== 0 ? tierDiff : aId.localeCompare(bId);
      })
      .map(([agentId, { tier, events }]) => ({ agentId, tier, events }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredEvents, windowMs]);

  if (!state.isLoaded) {
    return (
      <div className={`space-y-1 ${className}`} aria-busy="true" aria-label="Loading timeline">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-8 rounded bg-zinc-900/50 animate-pulse" aria-hidden="true" />
        ))}
      </div>
    );
  }

  if (lanes.length === 0) {
    return (
      <div className={`flex items-center justify-center py-6 ${className}`}>
        <p className="text-xs text-zinc-500">No activity in this window</p>
      </div>
    );
  }

  return (
    <div className={`${className}`} aria-label="Agent activity timeline">
      {/* Time axis labels */}
      <div className="flex items-center gap-2 mb-1 pl-36 pr-6">
        <div className="flex-1 flex justify-between text-[9px] text-zinc-700">
          <span>{windowMs >= 3600000 ? `${windowMs / 3600000}h ago` : `${windowMs / 60000}m ago`}</span>
          <span>now</span>
        </div>
      </div>

      {/* Lane rows */}
      <div role="table" aria-label="Agent timeline lanes">
        <div role="rowgroup">
          {lanes.map(({ agentId, tier, events }) => (
            <AgentLane
              key={agentId}
              agentId={agentId}
              tier={tier}
              events={events}
              windowMs={windowMs}
              nowMs={nowMs}
            />
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-x-3 gap-y-1 pt-2 pl-36">
        {(["in_progress", "completed", "failed", "review"] as const).map((s) => (
          <span key={s} className="inline-flex items-center gap-1 text-[9px] text-zinc-600">
            <span className={`w-2 h-2 rounded-full ${DOT_COLORS[s]}`} aria-hidden="true" />
            {s.replace(/_/g, " ")}
          </span>
        ))}
      </div>
    </div>
  );
}
