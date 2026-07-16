"use client";

import { useAgentActivity, type AgentActivityEvent } from "@/contexts/AgentActivityContext";
import { AgentStatusBadge, AgentTierBadge } from "./AgentStatusBadge";
import { ConfidenceBar } from "./ConfidenceGateFilter";

// ── Time formatting ────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// ── Arrow ──────────────────────────────────────────────────────────────────────

function TransitionArrow({ from, to }: { from: string | null; to: string }) {
  if (!from) {
    return <span className="text-xs text-zinc-500">created as {to.replace(/_/g, " ")}</span>;
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs">
      <span className="text-zinc-500">{from.replace(/_/g, " ")}</span>
      <span className="text-zinc-600" aria-label="to">&#8594;</span>
      <span
        className={
          to === "completed"
            ? "text-green-400 font-medium"
            : to === "failed" || to === "timed_out"
              ? "text-red-400 font-medium"
              : to === "blocked"
                ? "text-orange-400"
                : "text-white"
        }
      >
        {to.replace(/_/g, " ")}
      </span>
    </span>
  );
}

// ── Single event row ───────────────────────────────────────────────────────────

function EventRow({ event, isNew }: { event: AgentActivityEvent; isNew: boolean }) {
  return (
    <div
      className={`
        flex flex-col gap-2 p-3 border-b border-white/5 transition-colors
        ${isNew ? "bg-blue-500/5 animate-pulse-once" : "hover:bg-surface-raised/50"}
      `}
      role="listitem"
      aria-label={`${event.agentId} transitioned ${event.workItemTitle} to ${event.toState}`}
    >
      {/* Top row: agent + tier + transition */}
      <div className="flex items-start justify-between gap-2 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap min-w-0">
          <AgentTierBadge tier={event.tier} size="xs" />
          <span className="text-xs text-zinc-400 truncate max-w-[140px]" title={event.agentId}>
            {event.agentId}
          </span>
        </div>
        <span
          className="text-[10px] text-zinc-600 flex-shrink-0"
          title={new Date(event.timestamp).toLocaleString()}
        >
          {timeAgo(event.timestamp)}
        </span>
      </div>

      {/* Work item title + status */}
      <div className="flex items-center justify-between gap-2 min-w-0">
        <span className="text-sm text-zinc-200 truncate" title={event.workItemTitle}>
          {event.workItemTitle}
        </span>
        <AgentStatusBadge status={event.toState} size="xs" showDot />
      </div>

      {/* Transition arrow */}
      <div className="flex items-center justify-between gap-2">
        <TransitionArrow from={event.fromState} to={event.toState} />
        {event.costUsd !== null && (
          <span className="text-[10px] text-zinc-600">
            ${event.costUsd.toFixed(4)}
          </span>
        )}
      </div>

      {/* Confidence bar — only if gate data present */}
      {event.gateResults.length > 0 && (
        <ConfidenceBar
          score={event.confidenceScore}
          gateResults={event.gateResults}
          compact={false}
        />
      )}

      {/* Reason */}
      {event.reason && (
        <p className="text-[10px] text-zinc-500 line-clamp-2">{event.reason}</p>
      )}
    </div>
  );
}

// ── Empty state ────────────────────────────────────────────────────────────────

function EmptyState({ filtered }: { filtered: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center px-4">
      <div className="w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center mb-3">
        <span className="text-zinc-500 text-sm" aria-hidden="true">&#9679;</span>
      </div>
      <p className="text-sm text-zinc-500">
        {filtered ? "No events match the active gate filter" : "No agent activity yet"}
      </p>
      {filtered && (
        <p className="text-xs text-zinc-600 mt-1">Try removing a gate filter above</p>
      )}
    </div>
  );
}

// ── Props ──────────────────────────────────────────────────────────────────────

interface AgentActivityFeedProps {
  /** Max events to render (virtualization guard) */
  maxVisible?: number;
  /** Filter to specific tiers */
  tierFilter?: AgentActivityEvent["tier"][];
  className?: string;
}

// ── Component ──────────────────────────────────────────────────────────────────

export function AgentActivityFeed({
  maxVisible = 50,
  tierFilter,
  className = "",
}: AgentActivityFeedProps) {
  const { filteredEvents, state } = useAgentActivity();

  const events = tierFilter
    ? filteredEvents.filter((e) => tierFilter.includes(e.tier))
    : filteredEvents;

  const visible = events.slice(0, maxVisible);
  const hasFilter = state.gateFilter.length > 0 || (tierFilter?.length ?? 0) > 0;

  return (
    <div
      className={`flex flex-col ${className}`}
      role="list"
      aria-label="Agent activity feed"
      aria-busy={!state.isLoaded}
    >
      {!state.isLoaded ? (
        // Skeleton
        <div className="space-y-px">
          {[...Array(5)].map((_, i) => (
            <div
              key={i}
              className="h-20 bg-surface-raised animate-pulse border-b border-white/5"
              aria-hidden="true"
            />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <EmptyState filtered={hasFilter} />
      ) : (
        <>
          {visible.map((event, idx) => (
            <EventRow key={event.id} event={event} isNew={idx === 0 && state.isLoaded} />
          ))}
          {events.length > maxVisible && (
            <p className="text-center text-[10px] text-zinc-600 py-2">
              +{events.length - maxVisible} older events not shown
            </p>
          )}
        </>
      )}
    </div>
  );
}
