"use client";

import { useState } from "react";

interface Extraction {
  id: string;
  type: "knowledge" | "action" | "spec";
  title: string;
  content: string;
  confidence: number;
  tags: string[];
  preChecked: boolean;
}

interface AuditResultProps {
  result: Record<string, unknown>;
  costUsd: number | null;
  onConfirmExtractions?: (confirmedIds: string[], dismissedIds: string[]) => void;
  extractionsConfirmed?: boolean;
}

const ALIGNMENT_COLORS: Record<string, string> = {
  aligned: "text-emerald-400",
  minor_concerns: "text-yellow-400",
  major_concerns: "text-orange-400",
  violation: "text-red-400",
  unknown: "text-zinc-400",
};

const SCORE_COLORS: Record<string, string> = {
  high: "text-emerald-400",
  medium: "text-yellow-400",
  low: "text-red-400",
};

function scoreColor(score: number): string {
  if (score >= 7) return SCORE_COLORS.high;
  if (score >= 4) return SCORE_COLORS.medium;
  return SCORE_COLORS.low;
}

interface DimensionResult {
  score: number;
  [key: string]: unknown;
}

function isThreeDimensionAudit(result: Record<string, unknown>): boolean {
  return !!(result.constitutional && result.architectural && result.operational);
}

function DimensionCard({
  label,
  dimension,
  color,
}: {
  label: string;
  dimension: DimensionResult;
  color: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const details: string[] = [];

  // Constitutional specifics
  if (dimension.alignment) {
    details.push(`Alignment: ${String(dimension.alignment).replace(/_/g, " ")}`);
  }
  if (Array.isArray(dimension.findings) && dimension.findings.length > 0) {
    details.push(...(dimension.findings as string[]));
  }

  // Architectural specifics
  if (Array.isArray(dimension.adr_conflicts) && dimension.adr_conflicts.length > 0) {
    details.push(...(dimension.adr_conflicts as string[]).map((c) => `ADR conflict: ${c}`));
  }
  if (Array.isArray(dimension.tier_violations) && dimension.tier_violations.length > 0) {
    details.push(...(dimension.tier_violations as string[]).map((v) => `Tier violation: ${v}`));
  }
  if (Array.isArray(dimension.schema_impact) && dimension.schema_impact.length > 0) {
    details.push(`Schema impact: ${(dimension.schema_impact as string[]).join(", ")}`);
  }

  // Operational specifics
  if (dimension.budget_impact) {
    details.push(`Budget: ${dimension.budget_impact}`);
  }
  if (dimension.deployment_risk) {
    details.push(`Deploy risk: ${dimension.deployment_risk}`);
  }
  if (Array.isArray(dimension.operational_flags) && dimension.operational_flags.length > 0) {
    details.push(...(dimension.operational_flags as string[]));
  }

  return (
    <div className={`flex-1 p-3 bg-zinc-800/30 rounded-lg border ${color}`}>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] text-zinc-500 uppercase tracking-wide">{label}</span>
        <span className={`text-sm font-bold ${scoreColor(dimension.score)}`}>
          {dimension.score}/10
        </span>
      </div>
      {typeof dimension.recommendation === "string" && (
        <span className="text-xs text-zinc-300 block mb-1">
          {dimension.recommendation}
        </span>
      )}
      {details.length > 0 && (
        <ul className="space-y-0.5 mt-1">
          {(expanded ? details : details.slice(0, 3)).map((d, i) => (
            <li key={i} className="text-[11px] text-zinc-400" title={d}>
              {d}
            </li>
          ))}
          {details.length > 3 && !expanded && (
            <li>
              <button
                onClick={() => setExpanded(true)}
                className="text-[11px] text-accent-bright hover:underline"
              >
                +{details.length - 3} more
              </button>
            </li>
          )}
          {expanded && details.length > 3 && (
            <li>
              <button
                onClick={() => setExpanded(false)}
                className="text-[11px] text-zinc-500 hover:underline"
              >
                show less
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

const TYPE_STYLES: Record<string, { label: string; color: string; icon: string }> = {
  knowledge: { label: "Knowledge", color: "border-emerald-500/30 bg-emerald-500/5", icon: "KB" },
  action: { label: "Action", color: "border-blue-500/30 bg-blue-500/5", icon: "WI" },
  spec: { label: "Spec", color: "border-amber-500/30 bg-amber-500/5", icon: "SP" },
};

function ExtractionCards({
  extractions,
  onConfirm,
  confirmed,
}: {
  extractions: Extraction[];
  onConfirm?: (confirmedIds: string[], dismissedIds: string[]) => void;
  confirmed?: boolean;
}) {
  const [checked, setChecked] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(extractions.map((e) => [e.id, e.preChecked]))
  );
  const [submitting, setSubmitting] = useState(false);

  const toggle = (id: string) => setChecked((prev) => ({ ...prev, [id]: !prev[id] }));

  const handleConfirm = async () => {
    if (!onConfirm) return;
    setSubmitting(true);
    const confirmedIds = Object.entries(checked).filter(([, v]) => v).map(([k]) => k);
    const dismissedIds = Object.entries(checked).filter(([, v]) => !v).map(([k]) => k);
    await onConfirm(confirmedIds, dismissedIds);
    setSubmitting(false);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-400 uppercase tracking-wide">
          Extractions ({extractions.length})
        </span>
        {confirmed && <span className="text-[10px] text-emerald-400">Confirmed</span>}
      </div>

      {extractions.map((ext) => {
        const style = TYPE_STYLES[ext.type] || TYPE_STYLES.knowledge;
        return (
          <div
            key={ext.id}
            className={`rounded border p-3 ${style.color} ${checked[ext.id] ? "ring-1 ring-white/10" : "opacity-70"}`}
          >
            <div className="flex items-start gap-2">
              {!confirmed && (
                <input
                  type="checkbox"
                  checked={checked[ext.id] ?? false}
                  onChange={() => toggle(ext.id)}
                  className="mt-0.5 rounded border-zinc-600"
                />
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[9px] font-bold px-1 py-0.5 rounded bg-white/5 text-zinc-400">
                    {style.icon}
                  </span>
                  <span className="text-sm font-medium text-zinc-200 truncate">{ext.title}</span>
                  <span className="text-[10px] text-zinc-600 ml-auto whitespace-nowrap">
                    {Math.round(ext.confidence * 100)}%
                  </span>
                </div>
                <p className="text-xs text-zinc-400 mt-1">{ext.content}</p>
                {ext.tags.length > 0 && (
                  <div className="flex gap-1 mt-1.5">
                    {ext.tags.map((t) => (
                      <span key={t} className="text-[9px] px-1 py-0.5 rounded bg-zinc-800 text-zinc-500">
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}

      {!confirmed && onConfirm && (
        <button
          onClick={handleConfirm}
          disabled={submitting || Object.values(checked).every((v) => !v)}
          className="w-full py-2 text-sm font-medium bg-accent-bright text-white rounded-lg hover:bg-accent-bright/90 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {submitting ? "Confirming..." : `Confirm ${Object.values(checked).filter(Boolean).length} Extractions`}
        </button>
      )}
    </div>
  );
}

export default function AuditResults({ result, costUsd, onConfirmExtractions, extractionsConfirmed }: AuditResultProps) {
  const recommendation = result.recommendation as string;
  const flags = (result.flags as string[]) || [];
  const is3d = isThreeDimensionAudit(result);

  return (
    <div className="p-4 bg-zinc-800/50 rounded-lg border border-white/5 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium text-zinc-400">
          {is3d ? "Three-Dimension Audit" : "Audit Results"}
        </h3>
        <div className="flex items-center gap-2">
          {is3d && result.overall_score != null && (
            <span className={`text-sm font-bold ${scoreColor(result.overall_score as number)}`}>
              {String(result.overall_score)}/10
            </span>
          )}
          {costUsd != null && (
            <span className="text-[10px] text-zinc-600">${Number(costUsd).toFixed(4)}</span>
          )}
        </div>
      </div>

      {is3d ? (
        <>
          {/* Three dimension cards */}
          <div className="grid grid-cols-1 gap-2">
            <DimensionCard
              label="Constitutional"
              dimension={result.constitutional as DimensionResult}
              color="border-purple-500/20"
            />
            <DimensionCard
              label="Architectural"
              dimension={result.architectural as DimensionResult}
              color="border-blue-500/20"
            />
            <DimensionCard
              label="Operational"
              dimension={result.operational as DimensionResult}
              color="border-teal-500/20"
            />
          </div>

          {/* Overall recommendation */}
          {recommendation && (
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-zinc-500">Recommendation:</span>
              <span className="text-sm font-medium text-zinc-200">{recommendation}</span>
            </div>
          )}

          {/* Extraction cards (Liotta redesign: per-extraction confirmation) */}
          {Array.isArray(result.extractions) && (result.extractions as Extraction[]).length > 0 && (
            <ExtractionCards
              extractions={result.extractions as Extraction[]}
              onConfirm={onConfirmExtractions}
              confirmed={extractionsConfirmed}
            />
          )}
        </>
      ) : (
        <>
          {/* Legacy single-pass format */}
          <div className="flex gap-4">
            {typeof result.constitutional_alignment === "string" && (
              <div>
                <span className="text-[10px] text-zinc-500 block">Constitutional</span>
                <span
                  className={`text-sm font-medium ${ALIGNMENT_COLORS[result.constitutional_alignment] || "text-zinc-400"}`}
                >
                  {result.constitutional_alignment.replace(/_/g, " ")}
                </span>
              </div>
            )}
            {recommendation && (
              <div>
                <span className="text-[10px] text-zinc-500 block">Recommendation</span>
                <span className="text-sm font-medium text-zinc-200">{recommendation}</span>
              </div>
            )}
          </div>

          {result.audit_summary && (
            <p className="text-sm text-zinc-300">{String(result.audit_summary)}</p>
          )}
        </>
      )}

      {/* Flags — only shown for legacy single-pass format (3D cards already show details) */}
      {!is3d && flags.length > 0 && (
        <div className="space-y-1">
          <span className="text-[10px] text-zinc-500">Flags ({flags.length})</span>
          <ul className="space-y-1">
            {flags.slice(0, 6).map((flag, i) => (
              <li
                key={i}
                className="text-xs text-amber-300 pl-3 relative before:content-['!'] before:absolute before:left-0 before:text-amber-500"
              >
                {flag}
              </li>
            ))}
            {flags.length > 6 && (
              <li className="text-xs text-zinc-500 pl-3">+{flags.length - 6} more</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
