"use client";

import { useEffect, useState, useCallback, use, useMemo } from "react";
import Link from "next/link";
import { opsFetch, opsPost, opsPatch } from "@/lib/ops-api";
import { markdownToHtml } from "@/lib/markdown";
import MarkdownEditor from "@/components/ui/MarkdownEditor";

interface Iteration {
  iteration_number: number;
  quality_score: string | null;
  decision: string;
  cost_usd: string;
  duration_ms: number;
  strategy_used: Record<string, unknown>;
  git_commit_hash: string | null;
  failure_analysis: string | null;
  action_taken: string | null;
  created_at: string;
}

interface HistoryEvent {
  event_type: "iteration" | "hitl_request";
  id: string;
  iteration_number: number | null;
  quality_score: string | null;
  decision: string | null;
  cost_usd: string | null;
  duration_ms: number | null;
  failure_analysis: string | null;
  action_taken: string | null;
  strategy_used: Record<string, unknown> | null;
  question: string | null;
  answer: string | null;
  hitl_status: string | null;
  agent_id: string | null;
  git_commit_hash: string | null;
  created_at: string;
}

interface CampaignDetail {
  id: string;
  work_item_id: string;
  goal_description: string;
  campaign_status: string;
  campaign_mode: string;
  budget_envelope_usd: string;
  spent_usd: string;
  reserved_usd: string;
  max_iterations: number;
  completed_iterations: number;
  max_cost_per_iteration: string | null;
  success_criteria: Array<{ metric: string; operator: string; threshold: number }>;
  constraints: Record<string, unknown>;
  metadata: Record<string, unknown> | null;
  iteration_time_budget: string;
  plateau_window: number;
  plateau_threshold: string;
  workspace_path: string | null;
  source_intent_id: string | null;
  created_by: string;
  created_at: string;
  completed_at: string | null;
  work_item_title: string;
  iterations: Iteration[] | null;
  pr_url?: string;
  pr_number?: string;
  pr_branch?: string;
}

// --- Failure taxonomy ---
const FAILURE_CATEGORIES = [
  { key: "rate_limit", label: "Rate Limit", color: "bg-yellow-500/20 text-yellow-300 border-yellow-500/30", pattern: /rate.?limit|429|too many requests|quota/i },
  { key: "guard_check", label: "Guard Check", color: "bg-red-500/20 text-red-300 border-red-500/30", pattern: /guard.?check|constitutional|gate|G[1-8]/i },
  { key: "hitl_timeout", label: "HITL Timeout", color: "bg-violet-500/20 text-violet-300 border-violet-500/30", pattern: /hitl|timeout|awaiting.?input|waiting.?for/i },
  { key: "cli_error", label: "CLI Error", color: "bg-orange-500/20 text-orange-300 border-orange-500/30", pattern: /cli.?error|command.?fail|spawn|exec/i },
  { key: "json_parse", label: "JSON Parse", color: "bg-orange-500/20 text-orange-300 border-orange-500/30", pattern: /json|parse|syntax.?error|unexpected.?token/i },
  { key: "budget", label: "Budget", color: "bg-red-500/20 text-red-300 border-red-500/30", pattern: /budget|cost|exceed|overspend/i },
] as const;

function classifyFailure(text: string | null): string {
  if (!text) return "unknown";
  for (const cat of FAILURE_CATEGORIES) {
    if (cat.pattern.test(text)) return cat.key;
  }
  return "unknown";
}

function getFailureBadge(category: string) {
  const cat = FAILURE_CATEGORIES.find((c) => c.key === category);
  if (cat) return cat;
  return { key: "unknown", label: "Unknown", color: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30" };
}

const STATUS_COLORS: Record<string, string> = {
  pending_approval: "bg-yellow-500/20 text-yellow-300 border-yellow-500/30",
  approved: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  running: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
  paused: "bg-zinc-500/20 text-zinc-300 border-zinc-500/30",
  plateau_paused: "bg-orange-500/20 text-orange-300 border-orange-500/30",
  awaiting_input: "bg-violet-500/20 text-violet-300 border-violet-500/30",
  succeeded: "bg-green-500/20 text-green-300 border-green-500/30",
  failed: "bg-red-500/20 text-red-300 border-red-500/30",
  cancelled: "bg-zinc-600/20 text-zinc-400 border-zinc-600/30",
};

const DECISION_COLORS: Record<string, string> = {
  keep: "text-emerald-400",
  discard: "text-red-400",
  stop_success: "text-green-300",
  stop_error: "text-red-300",
  stop_budget: "text-yellow-300",
  stop_deadline: "text-orange-300",
  stop_plateau: "text-orange-400",
  stop_halt: "text-red-400",
};

export default function CampaignDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [campaign, setCampaign] = useState<CampaignDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [expandedIteration, setExpandedIteration] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [editGoal, setEditGoal] = useState("");
  const [editBudget, setEditBudget] = useState("");
  const [editIterations, setEditIterations] = useState("");
  const [editMode, setEditMode] = useState("");
  const [editMetadata, setEditMetadata] = useState("");
  const [saving, setSaving] = useState(false);
  const [hitlRequest, setHitlRequest] = useState<{ id: string; question: string; agent_id: string; created_at: string } | null>(null);
  const [hitlAnswer, setHitlAnswer] = useState("");
  const [hitlSubmitting, setHitlSubmitting] = useState(false);
  const [history, setHistory] = useState<HistoryEvent[]>([]);

  function startEdit() {
    if (!campaign) return;
    setEditGoal(campaign.goal_description);
    setEditBudget(campaign.budget_envelope_usd);
    setEditIterations(String(campaign.max_iterations));
    setEditMode(campaign.campaign_mode || "stateless");
    setEditMetadata(campaign.metadata ? JSON.stringify(campaign.metadata, null, 2) : "{}");
    setEditing(true);
  }

  async function saveEdit() {
    setSaving(true);
    let metadata: Record<string, unknown> | undefined;
    try { metadata = JSON.parse(editMetadata); } catch { /* ignore invalid JSON */ }
    const result = await opsPatch(`/api/campaigns/${id}`, {
      goal_description: editGoal,
      budget_envelope_usd: parseFloat(editBudget),
      max_iterations: parseInt(editIterations, 10),
      campaign_mode: editMode,
      ...(metadata !== undefined ? { metadata } : {}),
    });
    setSaving(false);
    if (result.ok) {
      setEditing(false);
      await load();
    }
  }

  const load = useCallback(async () => {
    const [data, hitlData, historyData] = await Promise.all([
      opsFetch<{ campaign: CampaignDetail }>(`/api/campaigns/${id}`),
      opsFetch<{ request: { id: string; question: string; agent_id: string; created_at: string } | null }>(`/api/campaigns/${id}/hitl/pending`),
      opsFetch<{ history: HistoryEvent[] }>(`/api/campaigns/${id}/history`),
    ]);
    setCampaign(data?.campaign || null);
    setHitlRequest(hitlData?.request || null);
    setHistory(historyData?.history || []);
    setLoading(false);
  }, [id]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, [load]);

  const scores = useMemo(() => {
    if (!campaign?.iterations) return [];
    return [...campaign.iterations]
      .reverse()
      .filter((it) => it.quality_score != null)
      .map((it) => ({
        iteration: it.iteration_number,
        score: parseFloat(it.quality_score!),
        decision: it.decision,
      }));
  }, [campaign?.iterations]);

  const maxScore = useMemo(() => Math.max(...scores.map((s) => s.score), 0.01), [scores]);

  // Failure stats
  const failureStats = useMemo(() => {
    if (!campaign?.iterations) return null;
    const all = campaign.iterations;
    const failed = all.filter((it) => it.failure_analysis);
    if (failed.length === 0) return null;
    const byCategory: Record<string, number> = {};
    for (const it of failed) {
      const cat = classifyFailure(it.failure_analysis);
      byCategory[cat] = (byCategory[cat] || 0) + 1;
    }
    return {
      total: all.length,
      failedCount: failed.length,
      byCategory,
      mostRecent: failed[failed.length - 1],
    };
  }, [campaign?.iterations]);

  // Cost trend
  const costStats = useMemo(() => {
    if (!campaign?.iterations || campaign.iterations.length === 0) return null;
    const costs = [...campaign.iterations].reverse().map((it) => parseFloat(it.cost_usd));
    const avg = costs.reduce((s, c) => s + c, 0) / costs.length;
    // trend: compare first half avg to second half avg
    let trend: "rising" | "falling" | "stable" = "stable";
    if (costs.length >= 4) {
      const mid = Math.floor(costs.length / 2);
      const firstHalf = costs.slice(0, mid).reduce((s, c) => s + c, 0) / mid;
      const secondHalf = costs.slice(mid).reduce((s, c) => s + c, 0) / (costs.length - mid);
      if (secondHalf > firstHalf * 1.15) trend = "rising";
      else if (secondHalf < firstHalf * 0.85) trend = "falling";
    }
    return { avg, trend, costs };
  }, [campaign?.iterations]);

  const [errorSummaryOpen, setErrorSummaryOpen] = useState(true);

  async function act(action: string) {
    setActing(true);
    await opsPost(`/api/campaigns/${id}/${action}`);
    await load();
    setActing(false);
  }

  async function submitHitlAnswer() {
    if (!hitlRequest || !hitlAnswer.trim()) return;
    setHitlSubmitting(true);
    await opsPost(`/api/campaigns/${id}/hitl/${hitlRequest.id}/respond`, { answer: hitlAnswer.trim() });
    setHitlAnswer("");
    setHitlRequest(null);
    await load();
    setHitlSubmitting(false);
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <div className="text-zinc-500 text-sm">Loading campaign...</div>
      </div>
    );
  }

  if (!campaign) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <div className="text-zinc-500 text-sm">Campaign not found</div>
      </div>
    );
  }

  const spent = parseFloat(campaign.spent_usd);
  const total = parseFloat(campaign.budget_envelope_usd);
  const budgetPct = total > 0 ? (spent / total) * 100 : 0;
  const iterations = campaign.iterations || [];

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-200 p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          <Link href="/campaigns" className="hover:text-zinc-300 transition-colors">Campaigns</Link>
          <span>/</span>
          <span className="text-zinc-300">{campaign.id.slice(0, 8)}</span>
        </div>

        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 mb-2">
              <span className={`px-2.5 py-1 rounded text-xs font-medium border ${STATUS_COLORS[campaign.campaign_status] || ""}`}>
                {campaign.campaign_status.replace(/_/g, " ")}
              </span>
              {campaign.campaign_mode && campaign.campaign_mode !== "stateless" && (
                <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-violet-500/20 text-violet-300">
                  {campaign.campaign_mode}
                </span>
              )}
              <span className="text-xs text-zinc-500">by {campaign.created_by}</span>
            </div>
            {editing ? (
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-zinc-400 mb-1">Goal (Markdown)</label>
                  <MarkdownEditor value={editGoal} onChange={setEditGoal} rows={5} />
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-zinc-400 mb-1">Budget ($)</label>
                    <input value={editBudget} onChange={(e) => setEditBudget(e.target.value)} type="number" step="0.01" min="0.50"
                      className="w-full bg-zinc-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-emerald-500/50" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-zinc-400 mb-1">Max Iterations</label>
                    <input value={editIterations} onChange={(e) => setEditIterations(e.target.value)} type="number" min="1" max="200"
                      className="w-full bg-zinc-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-emerald-500/50" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-zinc-400 mb-1">Mode</label>
                    <select value={editMode} onChange={(e) => setEditMode(e.target.value)}
                      className="w-full bg-zinc-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none">
                      <option value="stateless">Stateless</option>
                      <option value="stateful">Stateful</option>
                      <option value="workshop">Workshop</option>
                      <option value="project">Project</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-400 mb-1">Metadata (JSON)</label>
                  <textarea value={editMetadata} onChange={(e) => setEditMetadata(e.target.value)} rows={3}
                    className="w-full bg-zinc-800 border border-white/10 rounded-lg px-3 py-2 text-xs text-zinc-200 font-mono focus:outline-none focus:border-emerald-500/50" />
                </div>
                <div className="flex gap-2">
                  <button onClick={saveEdit} disabled={saving}
                    className="px-3 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-700 text-white rounded transition-colors">
                    {saving ? "Saving..." : "Save"}
                  </button>
                  <button onClick={() => setEditing(false)}
                    className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors">
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div
                className="prose prose-sm prose-invert max-w-none"
                dangerouslySetInnerHTML={{ __html: markdownToHtml(campaign.goal_description) }}
              />
            )}
          </div>

          {/* Board Actions */}
          <div className="flex gap-2 flex-shrink-0 flex-wrap">
            {campaign.pr_url && (
              <a href={campaign.pr_url}
                target="_blank" rel="noopener noreferrer"
                className="px-3 py-1.5 text-xs bg-purple-600/20 text-purple-300 border border-purple-500/30 rounded hover:bg-purple-600/30 transition-colors inline-flex items-center gap-1.5">
                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 16 16"><path d="M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.628a2.251 2.251 0 101.5 0V5A2.5 2.5 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z" /></svg>
                PR #{campaign.pr_number}
              </a>
            )}
            {typeof campaign.metadata?.preview_url === "string" && (
              <a href={campaign.metadata.preview_url}
                target="_blank" rel="noopener noreferrer"
                className="px-3 py-1.5 text-xs bg-emerald-600/20 text-emerald-300 border border-emerald-500/30 rounded hover:bg-emerald-600/30 transition-colors inline-flex items-center gap-1.5">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9" /></svg>
                Live Preview
              </a>
            )}
            {typeof campaign.metadata?.github_repo === "string" && (
              <a href={`https://github.com/${campaign.metadata.github_repo}`}
                target="_blank" rel="noopener noreferrer"
                className="px-3 py-1.5 text-xs bg-zinc-700/50 text-zinc-300 border border-white/10 rounded hover:bg-zinc-700 transition-colors inline-flex items-center gap-1.5">
                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 16 16"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" /></svg>
                Repo
              </a>
            )}
            {iterations.length > 0 && (
              <a href={`${process.env.NEXT_PUBLIC_API_URL || "https://preview.staqs.io"}/api/campaigns/${campaign.id}/preview`}
                target="_blank" rel="noopener noreferrer"
                className="px-3 py-1.5 text-xs bg-indigo-600/20 text-indigo-300 border border-indigo-500/30 rounded hover:bg-indigo-600/30 transition-colors inline-flex items-center gap-1.5">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                Preview
              </a>
            )}
            {iterations.length > 0 && (
              <a href={`${process.env.NEXT_PUBLIC_API_URL || "https://preview.staqs.io"}/api/campaigns/${campaign.id}/download`}
                className="px-3 py-1.5 text-xs bg-zinc-700/50 text-zinc-300 border border-white/10 rounded hover:bg-zinc-700 transition-colors inline-flex items-center gap-1.5">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                Download
              </a>
            )}
            {!editing && ["pending_approval", "approved"].includes(campaign.campaign_status) && (
              <button onClick={startEdit}
                className="px-3 py-1.5 text-xs bg-zinc-700/50 text-zinc-300 border border-white/10 rounded hover:bg-zinc-700 transition-colors">
                Edit
              </button>
            )}
            {campaign.campaign_status === "pending_approval" && (
              <button onClick={() => act("approve")} disabled={acting}
                className="px-3 py-1.5 text-xs bg-emerald-600/20 text-emerald-300 border border-emerald-500/30 rounded hover:bg-emerald-600/30 transition-colors disabled:opacity-50">
                Approve
              </button>
            )}
            {campaign.campaign_status === "running" && (
              <button onClick={() => act("pause")} disabled={acting}
                className="px-3 py-1.5 text-xs bg-yellow-600/20 text-yellow-300 border border-yellow-500/30 rounded hover:bg-yellow-600/30 transition-colors disabled:opacity-50">
                Pause
              </button>
            )}
            {["paused", "plateau_paused"].includes(campaign.campaign_status) && (
              <button onClick={() => act("resume")} disabled={acting}
                className="px-3 py-1.5 text-xs bg-blue-600/20 text-blue-300 border border-blue-500/30 rounded hover:bg-blue-600/30 transition-colors disabled:opacity-50">
                Resume
              </button>
            )}
            {!["succeeded", "failed", "cancelled"].includes(campaign.campaign_status) && (
              <button onClick={() => act("cancel")} disabled={acting}
                className="px-3 py-1.5 text-xs bg-red-600/20 text-red-300 border border-red-500/30 rounded hover:bg-red-600/30 transition-colors disabled:opacity-50">
                Cancel
              </button>
            )}
          </div>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Budget" value={`$${spent.toFixed(2)} / $${total.toFixed(2)}`} sub={`${budgetPct.toFixed(0)}% used`}
            color={budgetPct > 80 ? "text-red-400" : budgetPct > 50 ? "text-yellow-400" : "text-emerald-400"} />
          <StatCard
            label="Iterations"
            value={`${iterations.length} / ${campaign.max_iterations}`}
            sub={`${iterations.filter((i) => i.decision === "keep").length} kept`}
            progress={{
              pct: campaign.max_iterations > 0 ? (iterations.length / campaign.max_iterations) * 100 : 0,
              ariaLabel: `Task Completion: ${iterations.length} of ${campaign.max_iterations} iterations completed`,
            }}
            tooltip={`Metric: Task Completion | ${iterations.length}/${campaign.max_iterations} iterations completed (${campaign.max_iterations > 0 ? ((iterations.length / campaign.max_iterations) * 100).toFixed(0) : 0}%)`}
          />
          <StatCard label="Best Score"
            value={scores.length > 0 ? scores.reduce((best, s) => Math.max(best, s.score), 0).toFixed(4) : "N/A"} />
          <StatCard label="Avg Cost/Iter"
            value={costStats ? `$${costStats.avg.toFixed(3)}` : "N/A"}
            sub={costStats ? `Trend: ${costStats.trend === "rising" ? "rising" : costStats.trend === "falling" ? "falling" : "stable"}` : undefined}
            color={costStats?.trend === "rising" ? "text-red-400" : costStats?.trend === "falling" ? "text-emerald-400" : "text-zinc-200"} />
        </div>

        {/* Error Summary */}
        {failureStats && (
          <div className="bg-red-950/30 border border-red-500/20 rounded-lg overflow-hidden">
            <button
              onClick={() => setErrorSummaryOpen(!errorSummaryOpen)}
              className="w-full px-4 py-3 flex items-center gap-3 text-sm hover:bg-red-950/40 transition-colors"
            >
              <span className="text-red-400">{errorSummaryOpen ? "\u25BC" : "\u25B6"}</span>
              <span className="text-red-300 font-medium">
                {failureStats.failedCount} of {failureStats.total} iterations failed
              </span>
              <div className="flex gap-1.5 ml-2">
                {Object.entries(failureStats.byCategory).map(([cat, count]) => {
                  const badge = getFailureBadge(cat);
                  return (
                    <span key={cat} className={`px-1.5 py-0.5 rounded text-[10px] font-medium border ${badge.color}`}>
                      {badge.label} ({count})
                    </span>
                  );
                })}
              </div>
            </button>
            {errorSummaryOpen && failureStats.mostRecent && (
              <div className="px-4 pb-3 border-t border-red-500/10">
                <div className="mt-2 text-xs text-zinc-400">
                  <span className="text-zinc-500">Most recent failure (#{failureStats.mostRecent.iteration_number}):</span>
                </div>
                <pre className="mt-1 text-xs text-red-300/80 bg-zinc-950/50 rounded p-2 overflow-x-auto whitespace-pre-wrap max-h-32 overflow-y-auto">
                  {failureStats.mostRecent.failure_analysis}
                </pre>
              </div>
            )}
          </div>
        )}

        {/* HITL Panel — shown when campaign is awaiting operator input */}
        {campaign.campaign_status === "awaiting_input" && hitlRequest && (
          <div className="bg-violet-900/20 border border-violet-500/30 rounded-lg p-5 space-y-4">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-violet-400 animate-pulse" />
              <h3 className="text-sm font-semibold text-violet-300">Agent is waiting for your input</h3>
              <span className="ml-auto text-xs text-zinc-500">{new Date(hitlRequest.created_at).toLocaleString()}</span>
            </div>
            <div className="bg-zinc-900/60 border border-white/5 rounded-lg p-4">
              <p className="text-xs text-zinc-400 mb-1 font-medium">Question from <span className="text-violet-400">{hitlRequest.agent_id}</span>:</p>
              <p className="text-sm text-zinc-200 whitespace-pre-wrap">{hitlRequest.question}</p>
            </div>
            <div className="space-y-2">
              <textarea
                value={hitlAnswer}
                onChange={(e) => setHitlAnswer(e.target.value)}
                rows={4}
                placeholder="Type your answer here..."
                className="w-full bg-zinc-800 border border-violet-500/30 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-violet-400/70 resize-y placeholder-zinc-600"
              />
              <button
                onClick={submitHitlAnswer}
                disabled={hitlSubmitting || !hitlAnswer.trim()}
                className="px-4 py-2 text-sm bg-violet-600 hover:bg-violet-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded-lg transition-colors font-medium"
              >
                {hitlSubmitting ? "Submitting..." : "Submit Answer & Resume Campaign"}
              </button>
            </div>
          </div>
        )}

        {/* Success Criteria */}
        {campaign.success_criteria && campaign.success_criteria.length > 0 && (
          <div className="bg-zinc-900 border border-white/5 rounded-lg p-4">
            <h3 className="text-xs font-medium text-zinc-400 mb-2">Success Criteria</h3>
            <div className="flex flex-wrap gap-2">
              {campaign.success_criteria.map((sc, i) => (
                <span key={i} className="px-2 py-1 bg-zinc-800 rounded text-xs text-zinc-300">
                  {sc.metric} {sc.operator} {sc.threshold}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Score Sparkline */}
        {scores.length > 1 && (
          <div className="bg-zinc-900 border border-white/5 rounded-lg p-4">
            <h3 className="text-xs font-medium text-zinc-400 mb-3">Quality Score Over Iterations</h3>
            <div className="h-24 flex items-end gap-px">
              {scores.map((s, i) => {
                const height = maxScore > 0 ? (s.score / maxScore) * 100 : 0;
                return (
                  <div key={i} className="flex-1 flex flex-col items-center gap-1" title={`#${s.iteration}: ${s.score.toFixed(4)} (${s.decision})`}>
                    <div
                      className={`w-full rounded-t transition-all ${s.decision === "keep" ? "bg-emerald-500" : s.decision === "stop_success" ? "bg-green-400" : "bg-red-500/50"}`}
                      style={{ height: `${Math.max(height, 2)}%` }}
                    />
                  </div>
                );
              })}
            </div>
            <div className="flex justify-between text-xs text-zinc-600 mt-1">
              <span>#{scores[0]?.iteration}</span>
              <span>#{scores[scores.length - 1]?.iteration}</span>
            </div>
          </div>
        )}

        {/* Campaign History — chronological merge of iterations + HITL requests */}
        <div className="bg-zinc-900 border border-white/5 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-white/5">
            <h3 className="text-sm font-medium text-zinc-300">Campaign History</h3>
          </div>
          {history.length === 0 ? (
            <div className="p-8 text-center text-zinc-500 text-sm">No history yet</div>
          ) : (
            <div className="divide-y divide-white/5 max-h-[600px] overflow-y-auto">
              {history.map((event) => {
                if (event.event_type === "hitl_request") {
                  return (
                    <div key={`hitl-${event.id}`} className="border-l-2 border-violet-500/60">
                      <div className="px-4 py-3 flex items-start gap-3 bg-violet-900/10">
                        <span className="mt-0.5 shrink-0 w-4 text-violet-400 text-xs">?</span>
                        <div className="flex-1 min-w-0 space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-violet-500/20 text-violet-300 border border-violet-500/30">
                              Awaiting Input
                            </span>
                            <span className="text-xs text-zinc-500">{event.agent_id}</span>
                          </div>
                          <p className="text-xs text-zinc-200 whitespace-pre-wrap">{event.question}</p>
                          {event.answer && (
                            <div className="mt-2 pl-3 border-l border-violet-500/30">
                              <p className="text-[10px] text-zinc-500 mb-0.5">Answer:</p>
                              <p className="text-xs text-zinc-300 whitespace-pre-wrap">{event.answer}</p>
                            </div>
                          )}
                        </div>
                        <span className="text-zinc-600 text-xs shrink-0 ml-auto">
                          {new Date(event.created_at).toLocaleTimeString()}
                        </span>
                      </div>
                    </div>
                  );
                }

                // iteration event
                const isSuccess = event.decision === "stop_success";
                const isFailed = !!event.failure_analysis;
                const failureCategory = isFailed ? classifyFailure(event.failure_analysis) : null;
                const failureBadge = failureCategory ? getFailureBadge(failureCategory) : null;
                const isExpanded = expandedIteration === event.iteration_number;
                const isDiscard = event.decision === "discard";
                const hasStrategy = event.strategy_used && Object.keys(event.strategy_used).length > 0;
                const hasOutput = !!event.action_taken || !!event.failure_analysis || (isDiscard && hasStrategy);
                const qs = event.quality_score != null ? parseFloat(event.quality_score) : null;
                const qsColor = qs == null ? "text-zinc-500" : qs > 0.8 ? "text-emerald-400" : qs > 0.5 ? "text-yellow-400" : "text-red-400";
                return (
                  <div key={`iter-${event.id}`}
                    className={`${isSuccess ? "border-l-2 border-green-500" : isFailed ? "border-l-2 border-red-500/40" : ""}`}>
                    <div
                      className={`px-4 py-3 flex items-center gap-4 text-xs ${hasOutput ? "cursor-pointer hover:bg-white/[0.02]" : ""}`}
                      onClick={() => hasOutput && setExpandedIteration(isExpanded ? null : event.iteration_number)}
                    >
                      {hasOutput && (
                        <span className="text-zinc-600 w-4">{isExpanded ? "\u25BC" : "\u25B6"}</span>
                      )}
                      {!hasOutput && <span className="w-4" />}
                      <span className="text-zinc-500 w-8 text-right">#{event.iteration_number}</span>
                      <span className={`w-20 font-medium ${DECISION_COLORS[event.decision || ""] || "text-zinc-400"}`}>
                        {event.decision}
                      </span>
                      <span className={`w-16 font-medium ${qsColor}`}>
                        {qs != null ? qs.toFixed(4) : "-"}
                      </span>
                      <span className="text-zinc-500 w-16">${parseFloat(event.cost_usd || "0").toFixed(3)}</span>
                      <span className="text-zinc-600 w-16">{event.duration_ms ? `${(event.duration_ms / 1000).toFixed(1)}s` : "-"}</span>
                      {failureBadge && (
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium border shrink-0 ${failureBadge.color}`}>
                          {failureBadge.label}
                        </span>
                      )}
                      {event.git_commit_hash && (
                        <span className="text-blue-400 font-mono text-[11px]">{event.git_commit_hash.slice(0, 7)}</span>
                      )}
                      {event.failure_analysis && !failureBadge && (
                        <span className="text-zinc-500 truncate flex-1" title={event.failure_analysis}>
                          {event.failure_analysis}
                        </span>
                      )}
                      <span className="text-zinc-600 ml-auto shrink-0">
                        {new Date(event.created_at).toLocaleTimeString()}
                      </span>
                    </div>
                    {isExpanded && (event.action_taken || event.failure_analysis || (isDiscard && hasStrategy)) && (
                      <div className="px-4 pb-3 space-y-2">
                        {event.failure_analysis && (
                          <div className="bg-red-950/30 border border-red-500/10 rounded p-2">
                            <div className="text-[10px] text-red-400/70 mb-1 font-medium">Failure Analysis</div>
                            <pre className="text-xs text-red-300/80 whitespace-pre-wrap">{event.failure_analysis}</pre>
                          </div>
                        )}
                        {hasStrategy && (
                          <div className="bg-zinc-950 border border-white/5 rounded p-2">
                            <div className="text-[10px] text-zinc-500 mb-1 font-medium">Strategy Used</div>
                            <pre className="text-xs text-zinc-400 whitespace-pre-wrap">{JSON.stringify(event.strategy_used, null, 2)}</pre>
                          </div>
                        )}
                        {event.action_taken && (
                          <pre className="bg-zinc-950 border border-white/5 rounded p-3 text-xs text-zinc-300 overflow-x-auto whitespace-pre-wrap max-h-96 overflow-y-auto">
                            {event.action_taken}
                          </pre>
                        )}
                        {isDiscard && !event.failure_analysis && !event.action_taken && parseFloat(event.quality_score || "0") === 0 && (
                          <div className="bg-zinc-950 border border-white/5 rounded p-2">
                            <span className="text-xs text-zinc-500">No output produced (likely timeout or rate limit)</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Workspace Info */}
        {campaign.workspace_path && (
          <div className="bg-zinc-900 border border-white/5 rounded-lg p-4">
            <h3 className="text-xs font-medium text-zinc-400 mb-1">Workspace</h3>
            <code className="text-xs text-zinc-500">{campaign.workspace_path}</code>
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  color,
  progress,
  tooltip,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
  progress?: { pct: number; ariaLabel: string };
  tooltip?: string;
}) {
  return (
    <div className="bg-zinc-900 border border-white/5 rounded-lg p-3">
      <div className="text-xs text-zinc-500 mb-1">{label}</div>
      <div className={`text-sm font-medium ${color || "text-zinc-200"}`}>{value}</div>
      {sub && <div className="text-xs text-zinc-600 mt-0.5">{sub}</div>}
      {progress && (
        <div className="relative mt-2 group">
          {/* Progress bar */}
          <div
            className="h-1.5 rounded-full bg-zinc-700 overflow-hidden cursor-default"
            role="progressbar"
            aria-valuenow={progress.pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={progress.ariaLabel}
          >
            <div
              className="h-full rounded-full bg-emerald-500 transition-all duration-300"
              style={{ width: `${Math.min(progress.pct, 100)}%` }}
            />
          </div>
          {/* CSS-only tooltip — no JS, no render-blocking */}
          {tooltip && (
            <div
              role="tooltip"
              className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50
                         opacity-0 group-hover:opacity-100 transition-opacity duration-150
                         bg-zinc-800 border border-white/10 rounded px-2.5 py-1.5
                         text-xs text-zinc-200 whitespace-nowrap shadow-lg"
            >
              {tooltip}
              {/* Arrow */}
              <span
                className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-zinc-800"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
