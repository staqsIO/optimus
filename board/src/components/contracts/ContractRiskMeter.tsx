"use client";

import { useMemo, useState } from "react";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface RiskFinding {
  gate: "G2" | "G7";
  severity: "info" | "warn" | "block";
  title: string;
  excerpt: string;
  reason: string;
}

interface Props {
  findings: RiskFinding[] | null;
  scanning: boolean;
  lastScannedAt: Date | null;
  editable: boolean;
  onRescan: () => void;
}

/* ------------------------------------------------------------------ */
/*  Score / band logic                                                 */
/* ------------------------------------------------------------------ */

// Per-finding contribution to the 0–100 score. The numbers are deliberately
// tuned so a single block-severity finding lands in the red, two warns push
// past green, and pure info chatter stays in green.
const SEVERITY_WEIGHT: Record<RiskFinding["severity"], number> = {
  info: 8,
  warn: 22,
  block: 55,
};

function computeScore(findings: RiskFinding[] | null): number {
  if (!findings || findings.length === 0) return 0;
  const sum = findings.reduce((s, f) => s + (SEVERITY_WEIGHT[f.severity] ?? 0), 0);
  return Math.min(100, Math.round(sum));
}

function band(score: number): { tone: "green" | "amber" | "red"; label: string } {
  if (score < 30) return { tone: "green", label: "low risk" };
  if (score < 70) return { tone: "amber", label: "elevated" };
  return { tone: "red", label: "high risk" };
}

function timeAgo(d: Date | null): string {
  if (!d) return "never";
  const diffSec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  return `${Math.floor(diffSec / 3600)}h ago`;
}

/* ------------------------------------------------------------------ */
/*  Gauge SVG                                                          */
/* ------------------------------------------------------------------ */

function Gauge({ score, scanning }: { score: number; scanning: boolean }) {
  const { tone } = band(score);
  // Semi-circle dial from 180° (left, low risk) sweeping clockwise to 0° (right, high risk)
  // through 90° (top). Score maps linearly: 0→180°, 50→90°, 100→0°.
  const angleDeg = 180 - score * 1.8;
  const angleRad = (angleDeg * Math.PI) / 180;
  const cx = 100;
  const cy = 100;
  const r = 72;
  const tipX = cx + r * Math.cos(angleRad);
  const tipY = cy - r * Math.sin(angleRad); // subtract: SVG y grows down, dial opens up

  // Build the three colored zone arcs along the dial perimeter.
  const arcPath = (fromDeg: number, toDeg: number) => {
    const fromRad = (fromDeg * Math.PI) / 180;
    const toRad = (toDeg * Math.PI) / 180;
    const x1 = cx + r * Math.cos(fromRad);
    const y1 = cy - r * Math.sin(fromRad);
    const x2 = cx + r * Math.cos(toRad);
    const y2 = cy - r * Math.sin(toRad);
    // sweep flag = 0 (counterclockwise in SVG when y-up), but our y is flipped,
    // so 0 traces the upper half. large-arc = 0 since each segment ≤ 180°.
    return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
  };

  const greenColor = "rgb(52 211 153)";
  const amberColor = "rgb(251 191 36)";
  const redColor   = "rgb(248 113 113)";

  // Highlight the active zone, dim the others — keeps the gauge calm when
  // green and signals urgency when red without being a wall of color.
  const greenAlpha = tone === "green" ? 0.85 : 0.20;
  const amberAlpha = tone === "amber" ? 0.85 : 0.20;
  const redAlpha   = tone === "red"   ? 0.85 : 0.20;

  return (
    <svg viewBox="0 0 200 120" className="w-full max-w-[220px] mx-auto block" aria-hidden>
      {/* Zones: green 180°→126°, amber 126°→54°, red 54°→0° */}
      <path d={arcPath(180, 126)} stroke={greenColor} strokeOpacity={greenAlpha} strokeWidth={10} fill="none" strokeLinecap="round" />
      <path d={arcPath(126, 54)} stroke={amberColor} strokeOpacity={amberAlpha} strokeWidth={10} fill="none" />
      <path d={arcPath(54, 0)} stroke={redColor} strokeOpacity={redAlpha} strokeWidth={10} fill="none" strokeLinecap="round" />

      {/* Tick marks: small notches every 10 score units */}
      {Array.from({ length: 11 }).map((_, i) => {
        const tickAngle = ((180 - i * 18) * Math.PI) / 180;
        const innerR = r - 6;
        const outerR = r + 4;
        const x1 = cx + innerR * Math.cos(tickAngle);
        const y1 = cy - innerR * Math.sin(tickAngle);
        const x2 = cx + outerR * Math.cos(tickAngle);
        const y2 = cy - outerR * Math.sin(tickAngle);
        return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgb(82 82 91)" strokeWidth={i % 5 === 0 ? 1.2 : 0.6} />;
      })}

      {/* Needle — animated via CSS transform so the swing is smooth on rescan.
          Baseline is drawn pointing right (+x); rotate by (1.8*score − 180)°
          so score 0 → -180° (left), score 50 → -90° (up), score 100 → 0° (right).
          SVG rotate is clockwise, hence the negative angles for "upward" swings. */}
      <g
        style={{
          transform: `rotate(${1.8 * score - 180}deg)`,
          transformOrigin: `${cx}px ${cy}px`,
          transition: "transform 800ms cubic-bezier(0.34, 1.56, 0.64, 1)",
        }}
      >
        <line
          x1={cx}
          y1={cy}
          x2={cx + r - 6}
          y2={cy}
          stroke={tone === "red" ? redColor : tone === "amber" ? amberColor : greenColor}
          strokeWidth={2.5}
          strokeLinecap="round"
        />
      </g>

      {/* Hub */}
      <circle cx={cx} cy={cy} r={5} fill="rgb(24 24 27)" stroke="rgb(82 82 91)" strokeWidth={1.2} />

      {/* Score label inside */}
      <text
        x={cx}
        y={cy - 18}
        textAnchor="middle"
        className={`font-mono font-bold ${tone === "red" ? "fill-red-300" : tone === "amber" ? "fill-amber-300" : "fill-emerald-300"}`}
        style={{ fontSize: 22 }}
      >
        {score}
      </text>

      {scanning && (
        <text x={cx} y={cy + 12} textAnchor="middle" className="fill-zinc-500" style={{ fontSize: 8 }}>
          scanning…
        </text>
      )}

      {/* End-cap labels */}
      <text x={cx + r * Math.cos(Math.PI) - 4} y={cy + 12} textAnchor="end" className="fill-zinc-600" style={{ fontSize: 8 }}>low</text>
      <text x={cx + r * Math.cos(0) + 4} y={cy + 12} textAnchor="start" className="fill-zinc-600" style={{ fontSize: 8 }}>high</text>

      {/* Subtle pulse halo when scanning */}
      {scanning && (
        <circle cx={tipX} cy={tipY} r={6} fill="none" stroke="rgb(161 161 170)" strokeOpacity={0.5}>
          <animate attributeName="r" from="3" to="14" dur="1.2s" repeatCount="indefinite" />
          <animate attributeName="stroke-opacity" from="0.6" to="0" dur="1.2s" repeatCount="indefinite" />
        </circle>
      )}
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function ContractRiskMeter({ findings, scanning, lastScannedAt, editable, onRescan }: Props) {
  const score = useMemo(() => computeScore(findings), [findings]);
  const meta = band(score);
  const blocks = (findings || []).filter((f) => f.severity === "block").length;
  const warns  = (findings || []).filter((f) => f.severity === "warn").length;
  const infos  = (findings || []).filter((f) => f.severity === "info").length;
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="flex items-center justify-between mb-2">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Risk meter</div>
          <div className="text-[9px] text-zinc-600">G2 commitments · G7 precedent</div>
        </div>
        <button
          onClick={onRescan}
          disabled={scanning || !editable}
          title={editable ? "Re-run the pre-send scan now" : "Locked — contract is no longer editable"}
          className="text-[9px] px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {scanning ? "…" : "↻ scan"}
        </button>
      </div>

      <Gauge score={score} scanning={scanning} />

      <div className="mt-1 text-center">
        <span className={`text-[10px] font-medium uppercase tracking-wider ${
          meta.tone === "red"   ? "text-red-300"     :
          meta.tone === "amber" ? "text-amber-300"   :
                                  "text-emerald-300"
        }`}>
          {meta.label}
        </span>
      </div>

      {/* Severity breakdown chips */}
      {findings && findings.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1 justify-center">
          {blocks > 0 && (
            <span className="px-1.5 py-0.5 text-[9px] font-medium rounded bg-red-500/15 text-red-300 border border-red-500/30">
              {blocks} block
            </span>
          )}
          {warns > 0 && (
            <span className="px-1.5 py-0.5 text-[9px] font-medium rounded bg-amber-500/15 text-amber-200 border border-amber-500/30">
              {warns} warn
            </span>
          )}
          {infos > 0 && (
            <span className="px-1.5 py-0.5 text-[9px] font-medium rounded bg-sky-500/15 text-sky-300 border border-sky-500/30">
              {infos} info
            </span>
          )}
        </div>
      )}

      {/* Empty state when scan ran clean */}
      {findings && findings.length === 0 && !scanning && (
        <div className="mt-2 text-center text-[10px] text-emerald-400/80">
          ✓ No commitment or precedent issues
        </div>
      )}

      {findings === null && !scanning && (
        <div className="mt-2 text-center text-[10px] text-zinc-600">
          {editable ? "Edits trigger an auto-scan." : "Scan locked."}
        </div>
      )}

      <div className="mt-2 flex items-center justify-between text-[9px] text-zinc-600">
        <span>last scan {timeAgo(lastScannedAt)}</span>
        {findings && findings.length > 0 && (
          <button
            onClick={() => setExpanded((x) => !x)}
            className="text-zinc-500 hover:text-zinc-300"
          >
            {expanded ? "hide" : "details"}
          </button>
        )}
      </div>

      {/* Findings list — collapsed by default to keep the rail compact */}
      {expanded && findings && findings.length > 0 && (
        <ul className="mt-2 pt-2 border-t border-zinc-800 space-y-2">
          {findings.map((f, i) => (
            <li key={i} className="text-[10px]">
              <div className="flex items-center gap-1 mb-0.5">
                <span className={`px-1 py-0.5 text-[8px] font-medium rounded ${
                  f.severity === "block" ? "bg-red-500/20 text-red-300" :
                  f.severity === "warn"  ? "bg-amber-500/20 text-amber-200" :
                                           "bg-sky-500/20 text-sky-300"
                }`}>
                  {f.severity}
                </span>
                <span className="px-1 py-0.5 text-[8px] font-mono rounded bg-zinc-800 text-zinc-400">{f.gate}</span>
                <span className="text-[10px] font-medium text-zinc-200 truncate">{f.title}</span>
              </div>
              {f.excerpt && (
                <pre className="text-[9px] text-zinc-500 bg-zinc-950/50 border border-zinc-800/50 rounded px-1 py-0.5 mb-0.5 whitespace-pre-wrap break-words font-mono leading-snug max-h-[60px] overflow-y-auto">
                  {f.excerpt}
                </pre>
              )}
              {f.reason && (
                <div className="text-[10px] text-zinc-400 leading-snug">{f.reason}</div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
