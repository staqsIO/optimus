"use client";

import { useAgentActivity, ALL_GATES, GATE_META, type GateId } from "@/contexts/AgentActivityContext";

// ── WCAG-compliant color tokens per gate ───────────────────────────────────────

const GATE_COLORS: Record<GateId, { active: string; inactive: string; indicator: string }> = {
  G1: { active: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40 ring-emerald-500/30", inactive: "bg-zinc-800/60 text-zinc-500 border-zinc-700/40 hover:border-zinc-600/60", indicator: "bg-emerald-400" },
  G2: { active: "bg-red-500/20 text-red-300 border-red-500/40 ring-red-500/30",             inactive: "bg-zinc-800/60 text-zinc-500 border-zinc-700/40 hover:border-zinc-600/60", indicator: "bg-red-400" },
  G3: { active: "bg-blue-500/20 text-blue-300 border-blue-500/40 ring-blue-500/30",         inactive: "bg-zinc-800/60 text-zinc-500 border-zinc-700/40 hover:border-zinc-600/60", indicator: "bg-blue-400" },
  G4: { active: "bg-violet-500/20 text-violet-300 border-violet-500/40 ring-violet-500/30", inactive: "bg-zinc-800/60 text-zinc-500 border-zinc-700/40 hover:border-zinc-600/60", indicator: "bg-violet-400" },
  G5: { active: "bg-amber-500/20 text-amber-300 border-amber-500/40 ring-amber-500/30",     inactive: "bg-zinc-800/60 text-zinc-500 border-zinc-700/40 hover:border-zinc-600/60", indicator: "bg-amber-400" },
  G6: { active: "bg-cyan-500/20 text-cyan-300 border-cyan-500/40 ring-cyan-500/30",         inactive: "bg-zinc-800/60 text-zinc-500 border-zinc-700/40 hover:border-zinc-600/60", indicator: "bg-cyan-400" },
  G7: { active: "bg-orange-500/20 text-orange-300 border-orange-500/40 ring-orange-500/30", inactive: "bg-zinc-800/60 text-zinc-500 border-zinc-700/40 hover:border-zinc-600/60", indicator: "bg-orange-400" },
};

// ── Props ──────────────────────────────────────────────────────────────────────

interface ConfidenceGateFilterProps {
  /** Override to show only a subset of gates */
  gates?: GateId[];
  /** Label shown above the filter strip */
  label?: string;
  /** Show gate descriptions in tooltip */
  showDescriptions?: boolean;
  className?: string;
}

// ── Component ──────────────────────────────────────────────────────────────────

export function ConfidenceGateFilter({
  gates = ALL_GATES,
  label = "Gate filter",
  showDescriptions = true,
  className = "",
}: ConfidenceGateFilterProps) {
  const { state, toggleGate, setGateFilter } = useAgentActivity();
  const activeGates = state.gateFilter;
  const hasFilter = activeGates.length > 0;

  return (
    <div className={`space-y-2 ${className}`} role="group" aria-label="Constitutional gate filter">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-400">{label}</span>
        {hasFilter && (
          <button
            onClick={() => setGateFilter([])}
            className="text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors underline-offset-2 hover:underline"
            aria-label="Clear all gate filters"
          >
            clear all
          </button>
        )}
      </div>

      {/* Gate toggle chips */}
      <div className="flex flex-wrap gap-1.5" role="group">
        {gates.map((gateId) => {
          const isActive = activeGates.includes(gateId);
          const colors = GATE_COLORS[gateId];
          const meta = GATE_META[gateId];

          return (
            <button
              key={gateId}
              onClick={() => toggleGate(gateId)}
              aria-pressed={isActive}
              aria-label={`${isActive ? "Remove" : "Add"} ${meta.label} gate filter (${meta.description})`}
              title={showDescriptions ? meta.description : undefined}
              className={`
                inline-flex items-center gap-1.5 px-2 py-1 rounded border text-xs font-medium
                transition-all duration-150 cursor-pointer select-none
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-offset-black
                ${isActive ? `${colors.active} ring-1` : colors.inactive}
              `}
            >
              {/* Colored indicator dot */}
              <span
                className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${isActive ? colors.indicator : "bg-zinc-600"}`}
                aria-hidden="true"
              />
              {gateId}
              {isActive && (
                <span className="text-[9px] opacity-70">{meta.label}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Active filter summary */}
      {hasFilter && (
        <p className="text-[10px] text-zinc-500" aria-live="polite">
          Showing events where {activeGates.join(" + ")} passed
        </p>
      )}
    </div>
  );
}

// ── Inline confidence indicator badge ─────────────────────────────────────────

interface GateConfidenceIndicatorProps {
  /** Score 0–1 */
  score: number;
  className?: string;
}

/**
 * Compact inline badge showing a confidence score with WCAG AA color coding.
 * ≥90% green · ≥70% yellow · ≥50% orange · <50% red
 */
export function GateConfidenceIndicator({ score, className = "" }: GateConfidenceIndicatorProps) {
  const pct = Math.round(Math.max(0, Math.min(1, score)) * 100);
  const colorClass =
    pct >= 90
      ? "text-green-400"
      : pct >= 70
        ? "text-yellow-400"
        : pct >= 50
          ? "text-orange-400"
          : "text-red-400";

  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] font-medium tabular-nums ${colorClass} ${className}`}
      aria-label={`Confidence: ${pct}%`}
      title={`Constitutional gate confidence: ${pct}%`}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-current flex-shrink-0" aria-hidden="true" />
      {pct}%
    </span>
  );
}

// ── Inline confidence score bar (for use in feed rows) ─────────────────────────

interface ConfidenceBarProps {
  score: number; // 0–1
  gateResults: Array<{ gate: GateId; passed: boolean; score: number }>;
  compact?: boolean;
}

export function ConfidenceBar({ score, gateResults, compact = false }: ConfidenceBarProps) {
  const pct = Math.round(score * 100);
  const color =
    pct >= 90 ? "bg-green-500" : pct >= 70 ? "bg-yellow-500" : pct >= 50 ? "bg-orange-500" : "bg-red-500";

  if (compact) {
    return (
      <span
        className={`inline-block w-10 h-1.5 rounded-full bg-zinc-700 overflow-hidden align-middle`}
        title={`Confidence: ${pct}%`}
        aria-label={`Confidence score ${pct} percent`}
      >
        <span
          className={`block h-full rounded-full ${color}`}
          style={{ width: `${pct}%` }}
        />
      </span>
    );
  }

  return (
    <div className="space-y-1" aria-label={`Confidence score ${pct} percent`}>
      <div className="flex items-center justify-between text-[10px]">
        <span className="text-zinc-500">Confidence</span>
        <span className={pct >= 70 ? "text-zinc-300" : "text-orange-400"}>{pct}%</span>
      </div>
      <div className="w-full h-1 rounded-full bg-zinc-800 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${color}`}
          style={{ width: `${pct}%` }}
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </div>
      {gateResults.length > 0 && (
        <div className="flex gap-0.5 flex-wrap">
          {gateResults.map((r) => (
            <span
              key={r.gate}
              className={`text-[9px] px-1 py-0.5 rounded ${r.passed ? "text-green-400 bg-green-500/10" : "text-red-400 bg-red-500/10"}`}
              title={`${r.gate}: ${r.passed ? "pass" : "fail"} (${Math.round(r.score * 100)}%)`}
            >
              {r.gate}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
