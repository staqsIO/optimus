"use client";

import type { AgentTier, WorkItemStatus } from "@/contexts/AgentActivityContext";

// ── Status tokens ──────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<WorkItemStatus, string> = {
  created:    "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
  assigned:   "bg-blue-500/20 text-blue-400 border-blue-500/30",
  in_progress:"bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  review:     "bg-purple-500/20 text-purple-400 border-purple-500/30",
  completed:  "bg-green-500/20 text-green-400 border-green-500/30",
  failed:     "bg-red-500/20 text-red-400 border-red-500/30",
  blocked:    "bg-orange-500/20 text-orange-400 border-orange-500/30",
  timed_out:  "bg-red-500/20 text-red-300 border-red-500/20",
  cancelled:  "bg-zinc-600/20 text-zinc-500 border-zinc-600/20",
};

const STATUS_DOTS: Record<WorkItemStatus, string> = {
  created:    "bg-zinc-400",
  assigned:   "bg-blue-400",
  in_progress:"bg-yellow-400 animate-pulse",
  review:     "bg-purple-400",
  completed:  "bg-green-400",
  failed:     "bg-red-400",
  blocked:    "bg-orange-400",
  timed_out:  "bg-red-300",
  cancelled:  "bg-zinc-500",
};

// ── Tier tokens ────────────────────────────────────────────────────────────────

const TIER_STYLES: Record<AgentTier, string> = {
  strategist:   "bg-violet-500/15 text-violet-400 border-violet-500/25",
  architect:    "bg-indigo-500/15 text-indigo-400 border-indigo-500/25",
  orchestrator: "bg-cyan-500/15 text-cyan-400 border-cyan-500/25",
  reviewer:     "bg-purple-500/15 text-purple-400 border-purple-500/25",
  executor:     "bg-blue-500/15 text-blue-400 border-blue-500/25",
  utility:      "bg-zinc-500/15 text-zinc-400 border-zinc-500/25",
  external:     "bg-amber-500/15 text-amber-400 border-amber-500/25",
  unknown:      "bg-zinc-600/15 text-zinc-500 border-zinc-600/25",
};

// ── Props ──────────────────────────────────────────────────────────────────────

interface AgentStatusBadgeProps {
  status: WorkItemStatus;
  tier?: AgentTier;
  /** Show animated pulse dot */
  showDot?: boolean;
  /** Show tier label alongside status */
  showTier?: boolean;
  size?: "xs" | "sm" | "md";
  className?: string;
}

// ── Component ──────────────────────────────────────────────────────────────────

export function AgentStatusBadge({
  status,
  tier,
  showDot = true,
  showTier = false,
  size = "sm",
  className = "",
}: AgentStatusBadgeProps) {
  const sizeClass =
    size === "xs"
      ? "px-1.5 py-0.5 text-[10px]"
      : size === "sm"
        ? "px-2 py-0.5 text-xs"
        : "px-2.5 py-1 text-sm";

  const dotSize =
    size === "xs" ? "w-1.5 h-1.5" : size === "sm" ? "w-2 h-2" : "w-2.5 h-2.5";

  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      {/* Status badge */}
      <span
        className={`inline-flex items-center gap-1 rounded border font-medium ${sizeClass} ${STATUS_STYLES[status] ?? STATUS_STYLES.created}`}
        aria-label={`Status: ${status}`}
      >
        {showDot && (
          <span
            className={`rounded-full flex-shrink-0 ${dotSize} ${STATUS_DOTS[status] ?? STATUS_DOTS.created}`}
            aria-hidden="true"
          />
        )}
        {status.replace(/_/g, " ")}
      </span>

      {/* Optional tier badge */}
      {showTier && tier && tier !== "unknown" && (
        <span
          className={`inline-flex items-center rounded border font-medium ${sizeClass} ${TIER_STYLES[tier]}`}
          aria-label={`Tier: ${tier}`}
        >
          {tier}
        </span>
      )}
    </span>
  );
}

/** Standalone tier badge without status */
export function AgentTierBadge({
  tier,
  size = "sm",
  className = "",
}: {
  tier: AgentTier;
  size?: "xs" | "sm" | "md";
  className?: string;
}) {
  const sizeClass =
    size === "xs"
      ? "px-1.5 py-0.5 text-[10px]"
      : size === "sm"
        ? "px-2 py-0.5 text-xs"
        : "px-2.5 py-1 text-sm";

  return (
    <span
      className={`inline-flex items-center rounded border font-medium ${sizeClass} ${TIER_STYLES[tier]} ${className}`}
      aria-label={`Agent tier: ${tier}`}
    >
      {tier}
    </span>
  );
}
