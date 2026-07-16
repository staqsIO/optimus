"use client";

/**
 * DailyBriefingPanel — full daily briefing with stats, L0 exit criteria,
 * and the latest briefing narrative. Parity with CLI `briefing` command.
 */

import { useEffect, useState } from "react";
import { num, CriterionBar } from "@/components/shared/stats-helpers";

interface DailyStats {
  emails_received_today?: number | string;
  emails_triaged_today?: number | string;
  action_required_today?: number | string;
  needs_response_today?: number | string;
  drafts_created_today?: number | string;
  drafts_approved_today?: number | string;
  drafts_edited_today?: number | string;
  drafts_rejected_today?: number | string;
  drafts_awaiting_review?: number | string;
  drafts_reviewed_14d?: number | string;
  edit_rate_14d_pct?: number | string;
  cost_today_usd?: number | string;
  budget_today_usd?: number | string;
  emails_awaiting_triage?: number | string;
}

interface Briefing {
  briefing_date?: string;
  summary?: string;
  action_items?: string[] | string;
  signals?: string[] | string;
}

interface BriefingResponse {
  stats: DailyStats | null;
  briefing: Briefing | null;
}

function parseList(v: unknown): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v as string[];
  if (typeof v === "string") {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
  }
  return [];
}

export default function DailyBriefingPanel() {
  const [data, setData] = useState<BriefingResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function fetchBriefing() {
      try {
        const res = await fetch("/api/inbox-proxy?path=/api/briefing");
        if (res.ok && !cancelled) {
          const d = await res.json();
          setData(d);
        }
      } catch { /* silent */ }
      if (!cancelled) setLoading(false);
    }
    fetchBriefing();
    const interval = setInterval(fetchBriefing, 60_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  if (loading) {
    return (
      <div className="h-28 rounded-xl bg-zinc-800/40 border border-white/5 animate-pulse" />
    );
  }

  if (!data || !data.stats) return null;

  const s = data.stats;
  const briefing = data.briefing;
  const actionItems = parseList(briefing?.action_items);
  const signals = parseList(briefing?.signals);

  const cost = num(s.cost_today_usd);
  const budget = num(s.budget_today_usd, 20);
  const costPct = budget > 0 ? Math.round((cost / budget) * 100) : 0;
  const editRate = num(s.edit_rate_14d_pct);
  const reviewed = num(s.drafts_reviewed_14d);

  return (
    <section className="rounded-xl bg-zinc-800/40 border border-white/5 p-4 space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-zinc-200">Daily Briefing</h2>
        {briefing?.briefing_date && (
          <span className="text-[11px] text-zinc-500">
            {new Date(briefing.briefing_date).toLocaleDateString(undefined, {
              month: "short", day: "numeric",
            })}
          </span>
        )}
      </div>

      {/* Today metrics grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Metric label="Received" value={num(s.emails_received_today)} />
        <Metric label="Triaged" value={num(s.emails_triaged_today)} />
        <Metric label="Action req." value={num(s.action_required_today)} color="text-red-300" />
        <Metric label="Needs reply" value={num(s.needs_response_today)} color="text-amber-300" />
        <Metric label="Drafts created" value={num(s.drafts_created_today)} />
        <Metric label="Approved" value={num(s.drafts_approved_today)} color="text-emerald-300" />
        <Metric label="Edited" value={num(s.drafts_edited_today)} color="text-amber-300" />
        <Metric
          label="Cost today"
          value={`$${cost.toFixed(2)}`}
          sub={budget > 0 ? `${costPct}% of $${budget.toFixed(0)}` : undefined}
          color={costPct > 80 ? "text-red-300" : costPct > 50 ? "text-amber-300" : "text-zinc-200"}
        />
      </div>

      {/* L0 exit criteria */}
      <div className="rounded-lg bg-zinc-900/40 border border-white/5 p-3">
        <div className="text-[11px] text-zinc-500 mb-2">L0 exit criteria (14-day rolling)</div>
        <div className="space-y-2">
          <CriterionBar
            label="Edit rate"
            valueText={`${editRate.toFixed(1)}%`}
            pct={Math.min(100, editRate * 10 /* 10% target → full bar */)}
            target="target <10%"
            pass={editRate < 10 && reviewed >= 50}
            inverted
          />
          <CriterionBar
            label="Drafts reviewed"
            valueText={`${reviewed} / 50`}
            pct={Math.min(100, (reviewed / 50) * 100)}
            target="≥ 50"
            pass={reviewed >= 50}
          />
        </div>
      </div>

      {/* Latest briefing narrative */}
      {briefing?.summary && (
        <div className="rounded-lg bg-zinc-900/40 border border-white/5 p-3 space-y-2">
          <div className="text-[11px] text-zinc-500">Briefing summary</div>
          <p className="text-sm text-zinc-300 leading-relaxed">{briefing.summary}</p>

          {actionItems.length > 0 && (
            <div>
              <div className="text-[11px] text-zinc-500 mt-2 mb-1">Action items</div>
              <ul className="space-y-0.5">
                {actionItems.map((item, i) => (
                  <li key={i} className="text-xs text-amber-200/90">• {item}</li>
                ))}
              </ul>
            </div>
          )}

          {signals.length > 0 && (
            <div>
              <div className="text-[11px] text-zinc-500 mt-2 mb-1">Signals</div>
              <ul className="space-y-0.5">
                {signals.map((item, i) => (
                  <li key={i} className="text-xs text-zinc-300">• {item}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {!briefing?.summary && (
        <div className="text-[11px] text-zinc-500 italic">
          No briefing generated yet today.
        </div>
      )}
    </section>
  );
}

function Metric({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: number | string;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="rounded-lg bg-zinc-900/40 border border-white/5 px-3 py-2">
      <div className="text-[10px] text-zinc-500 uppercase tracking-wide">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${color || "text-zinc-200"}`}>
        {value}
      </div>
      {sub && <div className="text-[10px] text-zinc-600 mt-0.5">{sub}</div>}
    </div>
  );
}

