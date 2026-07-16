"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { timeAgo, StatCard } from "@/components/shared";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Stats {
  emails_received_today: number;
  emails_triaged_today: number;
  action_required_today: number;
  needs_response_today: number;
  emails_awaiting_triage: number;
  drafts_created_today: number;
  drafts_approved_today: number;
  drafts_edited_today: number;
  drafts_rejected_today: number;
  drafts_awaiting_review: number;
  drafts_reviewed_14d: number;
  edit_rate_14d_pct: number;
  cost_today_usd: string;
  budget_today_usd: string;
}

interface Briefing {
  summary: string;
  action_items: string[];
  signals: string[];
  trending_topics: string[];
  vip_activity: string[];
  briefing_date: string;
  emails_received: number;
  drafts_created: number;
  cost_usd: string;
}

interface PendingDraft {
  id: string;
  email_summary: string | null;
  draft_intent: string | null;
  reviewer_verdict: string;
  tone_score: number | null;
  created_at: string;
  from_address: string;
  from_name: string | null;
  subject: string;
  channel: string;
  account_label: string | null;
}

interface ActionEmail {
  id: string;
  from_address: string;
  from_name: string | null;
  subject: string;
  snippet: string;
  received_at: string;
  priority_score: number | null;
  channel: string;
  account_label: string | null;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function OverviewPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [pendingDrafts, setPendingDrafts] = useState<PendingDraft[]>([]);
  const [actionEmails, setActionEmails] = useState<ActionEmail[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/briefing`, { signal: AbortSignal.timeout(8000) });
      const data = await res.json();
      setStats(data?.stats ?? null);
      setBriefing(data?.briefing ?? null);
      setPendingDrafts(data?.pendingDrafts ?? []);
      setActionEmails(data?.actionEmails ?? []);
    } catch {
      // silent — will retry
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, [fetchData]);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-48 rounded bg-surface-raised animate-pulse" />
        <div className="h-20 rounded-lg bg-surface-raised animate-pulse" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-20 rounded-lg bg-surface-raised animate-pulse" />
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="h-64 rounded-lg bg-surface-raised animate-pulse" />
          <div className="h-64 rounded-lg bg-surface-raised animate-pulse" />
        </div>
        <div className="h-12 rounded-lg bg-surface-raised animate-pulse" />
      </div>
    );
  }

  // Check if pipeline has any activity at all
  const totalActivity =
    Number(stats?.emails_received_today ?? 0) +
    Number(stats?.emails_triaged_today ?? 0) +
    Number(stats?.drafts_created_today ?? 0);

  // Show helpful empty state when no emails have been processed yet
  if (!stats || totalActivity === 0) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight">Overview</h1>
          <span className="text-sm text-zinc-500">
            {new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
          </span>
        </div>
        <div className="bg-surface-raised rounded-lg border border-white/5 px-8 py-12 text-center">
          <div className="text-zinc-400 text-lg font-medium mb-2">No inbox activity yet today</div>
          <p className="text-sm text-zinc-500 max-w-md mx-auto">
            {stats
              ? "Your account is connected. The pipeline polls every 60 seconds — data will appear here as emails arrive and get triaged."
              : "Connect a Gmail account in Settings to start processing emails. Once connected, the pipeline will poll automatically."}
          </p>
          {stats && (
            <div className="mt-4 flex items-center justify-center gap-2">
              <svg className="animate-spin h-4 w-4 text-zinc-500" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-20" />
                <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
              </svg>
              <span className="text-xs text-zinc-500">Polling for new emails...</span>
            </div>
          )}
          {!stats && (
            <Link
              href="/settings"
              className="inline-block mt-4 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-dim"
            >
              Go to Settings
            </Link>
          )}
        </div>
        {briefing && (
          <div className="bg-surface-raised rounded-lg border border-white/5 overflow-hidden">
            <div className="px-5 py-3 border-b border-white/5">
              <h2 className="text-sm font-semibold text-zinc-300">Daily Briefing</h2>
            </div>
            <div className="px-5 py-4">
              <p className="text-sm text-zinc-300 leading-relaxed">{briefing.summary}</p>
            </div>
          </div>
        )}
      </div>
    );
  }

  const cost = parseFloat(stats?.cost_today_usd || "0");
  const budget = parseFloat(stats?.budget_today_usd || "20");
  const budgetPct = budget > 0 ? (cost / budget) * 100 : 0;

  return (
    <div className="space-y-6">
      {/* 1. Header with live pulse */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight">Overview</h1>
          <span
            className="h-2 w-2 rounded-full bg-status-approved animate-pulse"
            title="Polling every 10s"
          />
        </div>
        <span className="text-sm text-zinc-500">
          {new Date().toLocaleDateString(undefined, {
            weekday: "long",
            month: "long",
            day: "numeric",
          })}
        </span>
      </div>

      {/* 2. Pipeline Funnel — promoted to top */}
      <PipelineSummary stats={stats} />

      {/* 3. Stats Strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label="Emails Today"
          value={Number(stats?.emails_received_today ?? 0)}
          sub={`${Number(stats?.emails_triaged_today ?? 0)} triaged`}
        />
        <StatCard
          label="Needs Attention"
          value={Number(stats?.action_required_today ?? 0) + Number(stats?.needs_response_today ?? 0)}
          sub={`${stats?.action_required_today ?? 0} action, ${stats?.needs_response_today ?? 0} response`}
          color={Number(stats?.action_required_today ?? 0) > 0 ? "text-status-action" : undefined}
          urgent={Number(stats?.action_required_today ?? 0) > 0}
        />
        <StatCard
          label="Drafts Pending"
          value={Number(stats?.drafts_awaiting_review ?? 0)}
          sub={`${stats?.drafts_created_today ?? 0} created today`}
          color={Number(stats?.drafts_awaiting_review ?? 0) > 0 ? "text-status-response" : undefined}
          href="/drafts"
        />
        <div className="bg-surface-raised rounded-lg px-4 py-3 border border-white/5">
          <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-0.5">Cost Today</div>
          <div className="flex items-baseline gap-1.5">
            <span className={`text-lg font-bold tabular-nums ${budgetPct > 80 ? "text-status-action" : budgetPct > 50 ? "text-status-response" : "text-zinc-100"}`}>
              ${cost.toFixed(3)}
            </span>
            <span className="text-xs text-zinc-500">/ ${budget.toFixed(0)}</span>
          </div>
          <div className="mt-1.5 h-1 bg-surface-overlay rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${budgetPct > 80 ? "bg-status-action" : budgetPct > 50 ? "bg-status-response" : "bg-accent"}`}
              style={{ width: `${Math.min(100, budgetPct)}%` }}
            />
          </div>
        </div>
      </div>

      {/* 4. Two-column: Drafts (left, actionable) + Briefing (right, contextual) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left: Drafts to Review */}
        <div className="space-y-4">
          <div className="bg-surface-raised rounded-lg border border-white/5 overflow-hidden">
            <div className="px-5 py-3 border-b border-white/5 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-zinc-300">
                Drafts to Review
                <span className="text-zinc-500 font-normal ml-2">{pendingDrafts.length}</span>
              </h2>
              {pendingDrafts.length > 0 && (
                <Link
                  href="/drafts"
                  className="text-xs text-accent-bright hover:text-accent transition-colors"
                >
                  Review all &rarr;
                </Link>
              )}
            </div>
            {pendingDrafts.length > 0 ? (
              <div className="divide-y divide-white/5">
                {pendingDrafts.map((d) => (
                  <Link
                    key={d.id}
                    href="/drafts"
                    className="block px-5 py-3 hover:bg-white/[0.02] transition-colors"
                  >
                    <div className="flex items-center gap-2 mb-0.5">
                      <ChannelDot channel={d.channel} />
                      <span className="text-sm font-medium text-zinc-200 truncate">
                        {d.from_name || d.from_address}
                      </span>
                      <VerdictDot verdict={d.reviewer_verdict} />
                      {d.account_label && (
                        <span className="text-[10px] text-zinc-500 shrink-0">via {d.account_label}</span>
                      )}
                      <span className="text-xs text-zinc-500 shrink-0">{timeAgo(d.created_at)}</span>
                    </div>
                    {d.email_summary || d.draft_intent ? (
                      <div className="flex items-center gap-1.5 mt-0.5">
                        {d.email_summary && (
                          <span className="text-xs text-zinc-400 truncate">
                            <span className="text-zinc-500">asks:</span> {d.email_summary}
                          </span>
                        )}
                        {d.email_summary && d.draft_intent && (
                          <span className="text-zinc-700">&#8594;</span>
                        )}
                        {d.draft_intent && (
                          <span className="text-xs text-accent-bright/80 truncate">
                            {d.draft_intent}
                          </span>
                        )}
                      </div>
                    ) : (
                      <div className="text-xs text-zinc-500 truncate mt-0.5">
                        Re: {d.subject || "(no subject)"}
                      </div>
                    )}
                  </Link>
                ))}
              </div>
            ) : (
              <div className="px-5 py-8 text-center">
                <div className="text-zinc-500 text-sm">No drafts awaiting review.</div>
              </div>
            )}
          </div>

          {/* Action-required emails without drafts */}
          {actionEmails.length > 0 && (
            <div className="bg-surface-raised rounded-lg border border-white/5 overflow-hidden">
              <div className="px-5 py-3 border-b border-white/5">
                <h2 className="text-sm font-semibold text-zinc-300">
                  Awaiting Draft
                  <span className="text-zinc-500 font-normal ml-2">{actionEmails.length}</span>
                </h2>
              </div>
              <div className="divide-y divide-white/5">
                {actionEmails.map((e) => (
                  <div key={e.id} className="px-5 py-3">
                    <div className="flex items-center gap-2 mb-0.5">
                      <ChannelDot channel={e.channel} />
                      <span className="text-sm font-medium text-zinc-200 truncate">
                        {e.from_name || e.from_address}
                      </span>
                      {e.account_label && (
                        <span className="text-[10px] text-zinc-500 shrink-0">via {e.account_label}</span>
                      )}
                      <span className="text-xs text-zinc-500 shrink-0">{timeAgo(e.received_at)}</span>
                    </div>
                    <div className="text-sm text-zinc-400 truncate">{e.subject || "(no subject)"}</div>
                    <div className="text-xs text-zinc-500 truncate mt-0.5">{e.snippet}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right: Daily Briefing */}
        <div className="space-y-4">
          {briefing ? (
            <div className="bg-surface-raised rounded-lg border border-white/5 overflow-hidden">
              <div className="px-5 py-3 border-b border-white/5 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-zinc-300">Daily Briefing</h2>
                <span className="text-[11px] text-zinc-500">
                  {new Date(briefing.briefing_date).toLocaleDateString()}
                </span>
              </div>
              <div className="px-5 py-4">
                <p className="text-sm text-zinc-300 leading-relaxed mb-4">
                  {briefing.summary}
                </p>
                {briefing.action_items?.length > 0 && (
                  <div className="mb-3">
                    <h3 className="text-[11px] uppercase tracking-wider text-zinc-500 mb-2">Action Items</h3>
                    <ul className="space-y-1.5">
                      {briefing.action_items.map((item, i) => (
                        <li key={i} className="flex items-start gap-2 text-sm">
                          <span className="text-status-response mt-0.5 shrink-0">&#x2022;</span>
                          <span className="text-zinc-300">{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {briefing.signals?.length > 0 && (
                  <div>
                    <h3 className="text-[11px] uppercase tracking-wider text-zinc-500 mb-2">Signals</h3>
                    <ul className="space-y-1">
                      {briefing.signals.map((s, i) => (
                        <li key={i} className="text-sm text-zinc-400">{s}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="bg-surface-raised rounded-lg border border-white/5 px-5 py-8 text-center">
              <div className="text-zinc-500 text-sm mb-1">No briefing generated yet today.</div>
              <div className="text-zinc-700 text-xs">The architect agent produces one daily.</div>
            </div>
          )}
        </div>
      </div>

      {/* 5. L0 Exit Progress — collapsed summary, expandable */}
      <L0ExitSummary stats={stats} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pipeline Summary (promoted to position 2)
// ---------------------------------------------------------------------------

function PipelineSummary({ stats }: { stats: Stats | null }) {
  const received = Number(stats?.emails_received_today ?? 0);
  const triaged = Number(stats?.emails_triaged_today ?? 0);
  const drafted = Number(stats?.drafts_created_today ?? 0);
  const approved = Number(stats?.drafts_approved_today ?? 0);
  const edited = Number(stats?.drafts_edited_today ?? 0);
  const rejected = Number(stats?.drafts_rejected_today ?? 0);
  const awaiting = Number(stats?.emails_awaiting_triage ?? 0);

  return (
    <div className="bg-surface-raised rounded-lg border border-white/5 px-5 py-4">
      <h2 className="text-sm font-semibold text-zinc-300 mb-3">Today&apos;s Pipeline</h2>
      <div className="flex items-center gap-3">
        <PipelineStep label="Received" count={received} />
        <PipelineArrow />
        <PipelineStep label="Triaged" count={triaged} prevCount={received} />
        <PipelineArrow />
        <PipelineStep label="Drafted" count={drafted} prevCount={triaged} />
        <PipelineArrow />
        <PipelineStep label="Approved" count={approved} prevCount={drafted} color="text-status-approved" />
        {edited > 0 && (
          <>
            <div className="h-4 w-px bg-white/10 mx-1" />
            <PipelineStep label="Edited" count={edited} color="text-status-response" />
          </>
        )}
        {rejected > 0 && (
          <>
            <div className="h-4 w-px bg-white/10 mx-1" />
            <PipelineStep label="Rejected" count={rejected} color="text-status-action" />
          </>
        )}
        {awaiting > 0 && (
          <>
            <div className="flex-1" />
            <span className="text-xs text-zinc-500 tabular-nums">
              {awaiting} awaiting triage
            </span>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// L0 Exit Summary (collapsed by default)
// ---------------------------------------------------------------------------

function L0ExitSummary({ stats }: { stats: Stats | null }) {
  const [expanded, setExpanded] = useState(false);

  const draftsReviewed = Number(stats?.drafts_reviewed_14d ?? 0);
  const editRate = parseFloat(String(stats?.edit_rate_14d_pct ?? 100));
  const daysActive = 0;

  const criteriaMet = [
    draftsReviewed >= 50,
    editRate <= 10,
    daysActive >= 14,
  ].filter(Boolean).length;

  return (
    <div className="bg-surface-raised rounded-lg border border-white/5 px-5 py-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between text-left group"
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-zinc-400">L0 Exit Progress</span>
          <span className="text-xs text-zinc-500 tabular-nums">{criteriaMet}/3 criteria met</span>
          <div className="flex gap-1">
            {[draftsReviewed >= 50, editRate <= 10, daysActive >= 14].map((met, i) => (
              <div
                key={i}
                className={`h-2 w-2 rounded-full ${met ? "bg-status-approved" : "bg-surface-overlay"}`}
              />
            ))}
          </div>
        </div>
        <svg
          className={`h-4 w-4 text-zinc-500 transition-transform duration-200 ${expanded ? "rotate-180" : ""} group-hover:text-zinc-400`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {expanded && (
        <div className="grid grid-cols-3 gap-6 mt-3 pt-3 border-t border-white/5">
          <ProgressBar label="Drafts Reviewed" current={draftsReviewed} target={50} />
          <ProgressBar label="Edit Rate" current={editRate} target={10} inverted suffix="%" />
          <ProgressBar label="Days Active" current={daysActive} target={14} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function ProgressBar({
  label,
  current,
  target,
  inverted = false,
  suffix = "",
}: {
  label: string;
  current: number;
  target: number;
  inverted?: boolean;
  suffix?: string;
}) {
  const pct = inverted
    ? Math.max(0, 100 - (current / target) * 100)
    : Math.min(100, (current / target) * 100);
  const met = inverted ? current <= target : current >= target;

  return (
    <div>
      <div className="flex justify-between text-sm mb-1">
        <span className="text-zinc-400">{label}</span>
        <span className={met ? "text-status-approved" : "text-zinc-300"}>
          {current}{suffix} / {target}{suffix}
        </span>
      </div>
      <div className="h-1.5 bg-surface-overlay rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${met ? "bg-status-approved" : "bg-accent"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function PipelineStep({
  label,
  count,
  color,
  prevCount,
}: {
  label: string;
  count: number;
  color?: string;
  prevCount?: number;
}) {
  const throughputPct = prevCount && prevCount > 0
    ? Math.min(100, (count / prevCount) * 100)
    : undefined;

  return (
    <div className="text-center flex-1">
      <div className={`text-xl font-bold tabular-nums transition-all duration-300 ${color || "text-zinc-100"}`}>{count}</div>
      <div className="text-[11px] text-zinc-500 mt-0.5">{label}</div>
      {throughputPct !== undefined && (
        <div className="mt-1 mx-auto w-12 h-0.5 bg-surface-overlay rounded-full overflow-hidden">
          <div
            className="h-full bg-accent/50 rounded-full transition-all duration-500"
            style={{ width: `${throughputPct}%` }}
          />
        </div>
      )}
    </div>
  );
}

function PipelineArrow() {
  return (
    <svg width="20" height="12" viewBox="0 0 20 12" fill="none" className="text-zinc-700 shrink-0 mt-[-8px]">
      <path d="M0 6h16m0 0l-4-4m4 4l-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChannelDot({ channel }: { channel?: string }) {
  if (!channel || channel === "email") {
    return (
      <span className="text-[10px] text-blue-400 shrink-0" title="Email">
        {"\u2709"}
      </span>
    );
  }
  if (channel === "slack") {
    return (
      <span className="text-[10px] text-purple-400 shrink-0" title="Slack">
        #
      </span>
    );
  }
  return null;
}

function VerdictDot({ verdict }: { verdict: string }) {
  const colors: Record<string, string> = {
    approved: "bg-status-approved",
    flagged: "bg-status-response",
    rejected: "bg-status-action",
  };
  return (
    <div
      className={`h-2 w-2 rounded-full shrink-0 ${colors[verdict] || "bg-zinc-600"}`}
      title={verdict}
    />
  );
}
