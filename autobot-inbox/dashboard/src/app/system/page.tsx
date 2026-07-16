import { apiFetch } from "@/lib/api";
import SystemActions from "./SystemActions";

export const dynamic = "force-dynamic";

interface PhaseResponse {
  phase: number;
}

interface DeadManSwitch {
  status: string;
  daysSinceRenewal: number;
  consecutiveMissed: number;
  renewalIntervalDays: number;
}

interface GateDetail {
  name?: string;
  passing: boolean | null;
  value?: number | null;
  threshold?: number | null;
  reason?: string;
  windowDays?: number | null;
  measuredAt?: string | null;
  metadata?: Record<string, unknown>;
}

interface GatesResponse {
  gates: Record<string, GateDetail>;
  summary: { passing: number; total: number; allPassing: boolean };
}

interface ReadinessResponse {
  ready: boolean;
  consecutiveDays: number;
  requiredDays: number;
  gates: Record<string, unknown>;
  allPassing: boolean;
}

interface ExplorationResponse {
  explorationRatio: number;
  expectedRange: { min: number; max: number };
  withinBounds: boolean;
  metrics: Record<string, unknown>;
}

const PHASE_LABELS: Record<number, string> = {
  1: "Phase 1 — Foundation",
  2: "Phase 2 — Growth",
  3: "Phase 3 — Scale",
  4: "Phase 4 — Autonomy",
};

const SWITCH_STATUS_COLORS: Record<string, string> = {
  active: "bg-green-500/20 text-green-400 border-green-500/30",
  warning: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  expired: "bg-red-500/20 text-red-400 border-red-500/30",
};

export default async function SystemPage() {
  const safe = async <T,>(fn: () => Promise<T>): Promise<T | null> => {
    try { return await fn(); } catch { return null; }
  };

  const [phase, deadMan, gates, readiness, exploration] = await Promise.all([
    safe(() => apiFetch<PhaseResponse>("/api/phase/current")),
    safe(() => apiFetch<DeadManSwitch>("/api/phase/dead-man-switch")),
    safe(() => apiFetch<GatesResponse>("/api/gates")),
    safe(() => apiFetch<ReadinessResponse>("/api/gates/readiness")),
    safe(() => apiFetch<ExplorationResponse>("/api/phase/exploration")),
  ]);

  const currentPhase = phase?.phase ?? null;

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-4">
        <h1 className="text-2xl font-bold">System</h1>
        {currentPhase != null && (
          <span className="px-4 py-1.5 rounded-lg text-sm font-bold bg-blue-500/20 text-blue-400 border border-blue-500/30">
            {PHASE_LABELS[currentPhase] ?? `Phase ${currentPhase}`}
          </span>
        )}
      </div>

      {/* Phase Transition Readiness */}
      <section>
        <h2 className="text-lg font-semibold mb-4">Phase Transition Readiness</h2>
        {readiness ? (
          <div className="bg-surface-raised rounded-lg p-4 border border-white/5">
            <div className="flex items-center gap-3 mb-4">
              <span
                className={`px-2 py-0.5 rounded text-xs font-semibold ${
                  readiness.ready
                    ? "bg-green-500/20 text-green-400"
                    : "bg-yellow-500/20 text-yellow-400"
                }`}
              >
                {readiness.ready ? "READY" : "NOT READY"}
              </span>
              <span className="text-sm text-zinc-400">
                All gates passing: {readiness.allPassing ? "Yes" : "No"}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <div className="text-xs text-zinc-500 mb-1">Consecutive Days Passing</div>
                <div className="text-lg font-bold">
                  {readiness.consecutiveDays}{" "}
                  <span className="text-sm text-zinc-500">/ {readiness.requiredDays}</span>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="bg-surface-raised rounded-lg p-4 border border-white/5 text-zinc-500 text-sm">
            Readiness data unavailable.
          </div>
        )}
      </section>

      {/* Capability Gates */}
      <section>
        <h2 className="text-lg font-semibold mb-4">Capability Gates</h2>
        {gates ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {Object.entries(gates.gates).map(([key, g]) => {
              const statusColor =
                g.passing === true
                  ? "border-green-500/20"
                  : g.passing === false
                    ? "border-red-500/20"
                    : "border-zinc-500/20";
              const badgeColor =
                g.passing === true
                  ? "bg-green-500/20 text-green-400"
                  : g.passing === false
                    ? "bg-red-500/20 text-red-400"
                    : "bg-zinc-500/20 text-zinc-400";
              const badgeLabel =
                g.passing === true
                  ? "PASSING"
                  : g.passing === false
                    ? "FAILING"
                    : "NO DATA";

              return (
                <div
                  key={key}
                  className={`bg-surface-raised rounded-lg p-4 border ${statusColor}`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-zinc-500 font-semibold uppercase">
                      {key}
                    </span>
                    <span className={`text-xs px-1.5 py-0.5 rounded ${badgeColor}`}>
                      {badgeLabel}
                    </span>
                  </div>
                  {g.name && (
                    <div className="text-sm text-zinc-300 mb-2">{g.name}</div>
                  )}
                  {/* Reason — the key diagnostic line */}
                  {g.reason && (
                    <div className="text-xs text-zinc-400 mb-2 leading-relaxed">
                      {g.reason}
                    </div>
                  )}
                  {/* Value / Threshold */}
                  {g.value != null && (
                    <div className="text-sm mb-1">
                      <span className="text-xs text-zinc-500">Value: </span>
                      <span className="text-white font-medium">
                        {String(g.value)}
                      </span>
                      {g.threshold != null && (
                        <span className="text-zinc-500">
                          {" "}/ threshold: {String(g.threshold)}
                        </span>
                      )}
                    </div>
                  )}
                  {/* Window */}
                  {g.windowDays != null && (
                    <div className="text-xs text-zinc-600">
                      {g.windowDays}-day rolling window
                    </div>
                  )}
                  {/* Last measured */}
                  {g.measuredAt && (
                    <div className="text-xs text-zinc-600 mt-1">
                      Measured: {new Date(g.measuredAt).toLocaleString()}
                    </div>
                  )}
                  {/* Metadata details — verbose debug info */}
                  {g.metadata && Object.keys(g.metadata).length > 0 && (
                    <details className="mt-2">
                      <summary className="text-[10px] text-zinc-600 cursor-pointer hover:text-zinc-400">
                        Details
                      </summary>
                      <pre className="mt-1 text-[10px] text-zinc-500 bg-surface rounded p-2 overflow-x-auto max-h-40 overflow-y-auto whitespace-pre-wrap break-all">
                        {JSON.stringify(g.metadata, null, 2)}
                      </pre>
                    </details>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="bg-surface-raised rounded-lg p-4 border border-white/5 text-zinc-500 text-sm">
            Gate data unavailable.
          </div>
        )}
        {gates?.summary && (
          <div className="mt-3 text-sm text-zinc-400">
            {gates.summary.passing} / {gates.summary.total} gates passing
          </div>
        )}
      </section>

      {/* Dead-Man's Switch */}
      <section>
        <h2 className="text-lg font-semibold mb-4">Dead-Man&apos;s Switch</h2>
        {deadMan ? (
          <div className="bg-surface-raised rounded-lg p-4 border border-white/5">
            <div className="flex items-center gap-3 mb-4">
              <span
                className={`px-2 py-0.5 rounded text-xs font-semibold border ${
                  SWITCH_STATUS_COLORS[typeof deadMan.status === 'string' ? deadMan.status : ''] ?? "bg-zinc-500/20 text-zinc-400 border-zinc-500/30"
                }`}
              >
                {(typeof deadMan.status === 'string' ? deadMan.status : JSON.stringify(deadMan.status) ?? "unknown").toUpperCase()}
              </span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
              <div>
                <div className="text-xs text-zinc-500 mb-1">Days Since Renewal</div>
                <div className="text-lg font-bold">{deadMan.daysSinceRenewal}</div>
              </div>
              <div>
                <div className="text-xs text-zinc-500 mb-1">Consecutive Missed</div>
                <div className="text-lg font-bold">{deadMan.consecutiveMissed}</div>
              </div>
              <div>
                <div className="text-xs text-zinc-500 mb-1">Renewal Interval</div>
                <div className="text-lg font-bold">{deadMan.renewalIntervalDays} days</div>
              </div>
            </div>
          </div>
        ) : (
          <div className="bg-surface-raised rounded-lg p-4 border border-white/5 text-zinc-500 text-sm">
            Dead-man&apos;s switch data unavailable.
          </div>
        )}
      </section>

      {/* Exploration Ratio */}
      {exploration && (
        <section>
          <h2 className="text-lg font-semibold mb-4">Exploration Ratio</h2>
          <div className="bg-surface-raised rounded-lg p-4 border border-white/5">
            <div className="flex items-center gap-3 mb-3">
              <span
                className={`px-2 py-0.5 rounded text-xs font-semibold ${
                  exploration.withinBounds
                    ? "bg-green-500/20 text-green-400"
                    : "bg-yellow-500/20 text-yellow-400"
                }`}
              >
                {exploration.withinBounds ? "WITHIN BOUNDS" : "OUT OF BOUNDS"}
              </span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
              <div>
                <div className="text-xs text-zinc-500 mb-1">Current Ratio</div>
                <div className="text-lg font-bold">
                  {(Number(exploration.explorationRatio ?? 0) * 100).toFixed(1)}%
                </div>
              </div>
              {exploration.expectedRange && (
                <div>
                  <div className="text-xs text-zinc-500 mb-1">Expected Range</div>
                  <div className="text-lg font-bold">
                    {(Number(exploration.expectedRange.min) * 100).toFixed(1)}% &ndash;{" "}
                    {(Number(exploration.expectedRange.max) * 100).toFixed(1)}%
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {/* Action Buttons */}
      <SystemActions readinessReady={readiness?.ready ?? false} />
    </div>
  );
}
