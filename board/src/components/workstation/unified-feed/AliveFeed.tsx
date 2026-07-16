"use client";

/**
 * AliveFeed — lay-user "what are the agents doing?" surface for the Workstation.
 *
 * Renders a noise-filtered, plain-language stream of recent agent activity:
 * drafts created, tasks completed, signals resolved, campaigns advanced.
 * Designed to answer "is Optimus alive?" for a non-technical board member.
 *
 * OPT-42
 */

import { useAliveFeed, type AliveFeedEvent } from "./useAliveFeed";
import { getAgentDisplay } from "@/lib/agent-display";

// ── helpers ──────────────────────────────────────────────────────────────────

function timeAgo(ts: string): string {
  const mins = (Date.now() - new Date(ts).getTime()) / 60_000;
  if (mins < 1) return "just now";
  if (mins < 60) return `${Math.round(mins)}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

// ── sub-components ────────────────────────────────────────────────────────────

function AgentDot({ agentId }: { agentId: string }) {
  const d = getAgentDisplay(agentId);
  return (
    <div
      title={d.displayName}
      className={`w-6 h-6 rounded-full ${d.color} flex items-center justify-center text-white text-[9px] font-bold flex-shrink-0`}
    >
      {d.initials}
    </div>
  );
}

function KindPill({ kind }: { kind: AliveFeedEvent["kind"] }) {
  const map: Record<AliveFeedEvent["kind"], { label: string; cls: string }> = {
    draft:    { label: "Draft",    cls: "bg-amber-500/15 text-amber-400" },
    signal:   { label: "Signal",   cls: "bg-teal-500/15 text-teal-400" },
    task:     { label: "Task",     cls: "bg-blue-500/15 text-blue-400" },
    campaign: { label: "Campaign", cls: "bg-purple-500/15 text-purple-400" },
    intent:   { label: "Intent",   cls: "bg-red-500/15 text-red-400" },
  };
  const { label, cls } = map[kind] ?? { label: kind, cls: "bg-zinc-500/15 text-zinc-400" };
  return (
    <span className={`px-1.5 py-0.5 text-[9px] rounded-full font-medium ${cls}`}>
      {label}
    </span>
  );
}

function EventRow({ event }: { event: AliveFeedEvent }) {
  const d = getAgentDisplay(event.agentId);
  return (
    <div className="flex items-start gap-2.5 py-2.5 px-3 hover:bg-white/[0.02] transition-colors rounded-lg">
      <AgentDot agentId={event.agentId} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-1.5 flex-wrap">
          <span className="text-xs font-medium text-zinc-200">{d.displayName}</span>
          <span className="text-xs text-zinc-400">{event.headline}</span>
          <span className="text-[10px] text-zinc-600 ml-auto flex-shrink-0">{timeAgo(event.timestamp)}</span>
        </div>
        <div className="flex items-center gap-1.5 mt-0.5">
          <KindPill kind={event.kind} />
          {event.detail && (
            <span className="text-[10px] text-zinc-500 truncate max-w-[260px]" title={event.detail}>
              {event.detail}
            </span>
          )}
          {event.requiresAction && (
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-300">
              Action needed
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── main component ────────────────────────────────────────────────────────────

interface AliveFeedProps {
  /** Max events to display (default 20) */
  limit?: number;
  /** Optional CSS class override on the wrapper */
  className?: string;
}

export default function AliveFeed({ limit = 20, className }: AliveFeedProps) {
  const { events, loading, error } = useAliveFeed(limit + 20); // fetch extra for filter headroom
  const visible = events.slice(0, limit);

  return (
    <div className={`flex flex-col ${className ?? ""}`}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-white/5">
        <div className="flex items-center gap-2">
          {/* Pulse dot: green when we have fresh data, dimmed when loading/offline */}
          <span
            className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
              error
                ? "bg-red-500/60"
                : loading && events.length === 0
                  ? "bg-zinc-500 animate-pulse"
                  : "bg-emerald-500 animate-pulse"
            }`}
          />
          <span className="text-xs font-medium text-zinc-200">Agents</span>
          {events.length > 0 && (
            <span className="text-[10px] text-zinc-600">{events.length} recent events</span>
          )}
        </div>
        {loading && events.length > 0 && (
          <div className="w-3 h-3 border border-zinc-600 border-t-zinc-400 rounded-full animate-spin" />
        )}
      </div>

      {/* Body */}
      {error && events.length === 0 ? (
        <div className="flex items-center justify-center py-8 text-xs text-zinc-600 gap-2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          {error}
        </div>
      ) : loading && events.length === 0 ? (
        /* Skeleton shimmer rows */
        <div className="divide-y divide-white/5">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-start gap-2.5 py-2.5 px-3 animate-pulse">
              <div className="w-6 h-6 rounded-full bg-white/10 flex-shrink-0" />
              <div className="flex-1 space-y-1.5">
                <div className="h-3 rounded bg-white/10 w-3/4" />
                <div className="h-2.5 rounded bg-white/5 w-1/2" />
              </div>
            </div>
          ))}
        </div>
      ) : visible.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-10 gap-2 text-zinc-600">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 9.75l4.5 4.5m0-4.5l-4.5 4.5M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="text-xs">No recent agent activity</span>
        </div>
      ) : (
        <div className="divide-y divide-white/[0.04]">
          {visible.map((event) => (
            <EventRow key={event.id} event={event} />
          ))}
        </div>
      )}

      {/* Footer: show count if truncated */}
      {events.length > limit && (
        <div className="px-3 py-2 border-t border-white/5 text-[10px] text-zinc-600 text-center">
          Showing {limit} of {events.length} events
        </div>
      )}
    </div>
  );
}
