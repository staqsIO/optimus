"use client";

import { useState, useEffect, useCallback } from "react";
import SubmissionDetail from "./SubmissionDetail";

interface GovernanceSubmission {
  id: string;
  title: string;
  content_type: string;
  source_format: string;
  submitted_by: string;
  status: string;
  impact_level: string | null;
  urgency: string | null;
  spec_domains: string[];
  affected_adrs: string[];
  audit_result: Record<string, unknown> | null;
  audit_completed: string | null;
  audit_cost_usd: number | null;
  decision_by: string | null;
  decision_at: string | null;
  decision_reason: string | null;
  work_item_id: string | null;
  pr_url: string | null;
  discussion_thread: Array<{ author: string; message: string; created_at: string }>;
  created_at: string;
  updated_at: string;
  discussion_count: number;
}

const STATUS_STYLES: Record<string, string> = {
  submitted: "bg-zinc-500/20 text-zinc-300 border-zinc-500/30",
  auditing: "bg-yellow-500/20 text-yellow-300 border-yellow-500/30",
  awaiting_review: "bg-purple-500/20 text-purple-300 border-purple-500/30",
  discussing: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  accepted: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
  rejected: "bg-red-500/20 text-red-300 border-red-500/30",
  deferred: "bg-amber-500/20 text-amber-300 border-amber-500/30",
  superseded: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
};

const TYPE_LABELS: Record<string, string> = {
  spec_amendment: "Spec Amendment",
  agent_proposal: "Agent Proposal",
  research: "Research",
  idea: "Idea",
  adr: "ADR",
  process_improvement: "Process",
  external_reference: "External",
};

const IMPACT_COLORS: Record<string, string> = {
  critical: "text-red-400",
  high: "text-orange-400",
  medium: "text-yellow-400",
  low: "text-zinc-400",
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function SubmissionInbox() {
  const [submissions, setSubmissions] = useState<GovernanceSubmission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("active");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchActing, setBatchActing] = useState(false);

  const fetchSubmissions = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (statusFilter && statusFilter !== "all" && statusFilter !== "active") {
        params.set("status", statusFilter);
      }
      const res = await fetch(`/api/governance?path=/api/governance/submissions${params.toString() ? `&${params}` : ""}`);
      if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
      const data = await res.json();
      let items = data.submissions || [];
      // Client-side filter for "active" (non-terminal states)
      if (statusFilter === "active") {
        items = items.filter((s: GovernanceSubmission) =>
          !["accepted", "rejected", "deferred", "superseded"].includes(s.status)
        );
      }
      setSubmissions(items);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    fetchSubmissions();
    const interval = setInterval(fetchSubmissions, 15000);
    return () => clearInterval(interval);
  }, [fetchSubmissions]);

  const selected = submissions.find((s) => s.id === selectedId) || null;

  const decidableIds = submissions
    .filter((s) => ["awaiting_review", "discussing"].includes(s.status))
    .map((s) => s.id);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelectedIds((prev) =>
      prev.size === decidableIds.length
        ? new Set()
        : new Set(decidableIds)
    );
  }, [decidableIds]);

  const handleBatchDecide = useCallback(async (decision: string) => {
    if (selectedIds.size === 0) return;
    setBatchActing(true);
    const ids = Array.from(selectedIds);
    const CHUNK_SIZE = 5;
    let failed = 0;

    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      const chunk = ids.slice(i, i + CHUNK_SIZE);
      const results = await Promise.allSettled(
        chunk.map((id) =>
          fetch(`/api/governance/${id}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "decide", decision }),
          })
        )
      );
      failed += results.filter((r) => r.status === "rejected").length;
    }

    if (failed > 0) {
      setError(`${failed} of ${ids.length} batch actions failed`);
    }
    setSelectedIds(new Set());
    setBatchActing(false);
    fetchSubmissions();
  }, [selectedIds, fetchSubmissions]);

  const statusGroups = [
    { key: "active", label: "Active" },
    { key: "awaiting_review", label: "Awaiting Review" },
    { key: "discussing", label: "Discussing" },
    { key: "accepted", label: "Accepted" },
    { key: "rejected", label: "Rejected" },
    { key: "all", label: "All" },
  ];

  return (
    <div className="space-y-4">
      {/* Status filter tabs */}
      <div className="flex gap-1.5 overflow-x-auto">
        {statusGroups.map((g) => (
          <button
            key={g.key}
            onClick={() => setStatusFilter(g.key)}
            className={`px-3 py-1.5 text-xs rounded-full border transition-colors whitespace-nowrap ${
              statusFilter === g.key
                ? "bg-accent-bright/20 text-accent-bright border-accent-bright/30"
                : "bg-white/[0.03] text-zinc-500 border-white/5 hover:bg-white/[0.06] hover:text-zinc-400"
            }`}
          >
            {g.label}
          </button>
        ))}
      </div>

      {/* Error state */}
      {error && (
        <div className="px-4 py-3 text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg">
          {error}
        </div>
      )}

      {/* Loading state */}
      {loading && (
        <div className="text-center py-8 text-zinc-500 text-sm">Loading submissions...</div>
      )}

      {/* Empty state */}
      {!loading && submissions.length === 0 && (
        <div className="text-center py-12 text-zinc-500">
          <p className="text-sm">No submissions found</p>
          <p className="text-xs mt-1 text-zinc-600">Use the intake command bar to submit ideas, research, or spec amendments</p>
        </div>
      )}

      {/* Batch action bar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 px-4 py-2.5 bg-zinc-800/80 rounded-lg border border-white/10">
          <span className="text-xs text-zinc-300">{selectedIds.size} selected</span>
          <button
            onClick={() => handleBatchDecide("accepted")}
            disabled={batchActing}
            className="px-3 py-1 text-xs bg-emerald-500/20 text-emerald-300 rounded-full hover:bg-emerald-500/30 transition-colors disabled:opacity-40"
          >
            Accept All
          </button>
          <button
            onClick={() => handleBatchDecide("deferred")}
            disabled={batchActing}
            className="px-3 py-1 text-xs bg-amber-500/20 text-amber-300 rounded-full hover:bg-amber-500/30 transition-colors disabled:opacity-40"
          >
            Defer All
          </button>
          <button
            onClick={() => setSelectedIds(new Set())}
            className="px-3 py-1 text-xs bg-zinc-700 text-zinc-400 rounded-full hover:bg-zinc-600 transition-colors"
          >
            Clear
          </button>
          {batchActing && <span className="text-xs text-zinc-500">Processing...</span>}
        </div>
      )}

      {/* Submission list */}
      {!loading && submissions.length > 0 && (
        <div className="space-y-2">
          {/* Select all toggle */}
          {decidableIds.length > 1 && (
            <label className="flex items-center gap-2 px-4 py-1 text-[11px] text-zinc-500 cursor-pointer hover:text-zinc-400">
              <input
                type="checkbox"
                checked={selectedIds.size === decidableIds.length && decidableIds.length > 0}
                onChange={toggleAll}
                className="rounded border-zinc-600 bg-zinc-800 text-accent-bright focus:ring-accent-bright/50"
              />
              Select all reviewable ({decidableIds.length})
            </label>
          )}
          {submissions.map((sub) => {
            const isDecidable = ["awaiting_review", "discussing"].includes(sub.status);
            return (
              <div
                key={sub.id}
                className={`flex items-start gap-2 px-4 py-3 rounded-lg border transition-colors ${
                  selectedId === sub.id
                    ? "bg-white/[0.06] border-accent-bright/30"
                    : "bg-white/[0.02] border-white/5 hover:bg-white/[0.04] hover:border-white/10"
                }`}
              >
                {/* Checkbox for batch selection */}
                {isDecidable && (
                  <input
                    type="checkbox"
                    checked={selectedIds.has(sub.id)}
                    onChange={() => toggleSelect(sub.id)}
                    className="mt-1 rounded border-zinc-600 bg-zinc-800 text-accent-bright focus:ring-accent-bright/50 flex-shrink-0"
                    onClick={(e) => e.stopPropagation()}
                  />
                )}
                {!isDecidable && <div className="w-4 flex-shrink-0" />}
                <button
                  className="flex-1 text-left min-w-0"
                  onClick={() => setSelectedId(sub.id)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`inline-flex px-2 py-0.5 text-[10px] rounded-full border ${STATUS_STYLES[sub.status] || STATUS_STYLES.submitted}`}>
                          {sub.status.replace(/_/g, " ")}
                        </span>
                        <span className="text-[10px] text-zinc-500">
                          {TYPE_LABELS[sub.content_type] || sub.content_type}
                        </span>
                        {sub.impact_level && (
                          <span className={`text-[10px] ${IMPACT_COLORS[sub.impact_level] || "text-zinc-500"}`}>
                            {sub.impact_level}
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-zinc-200 truncate">{sub.title}</p>
                      <div className="flex items-center gap-3 mt-1 text-[11px] text-zinc-500">
                        <span>{sub.submitted_by}</span>
                        <span>{timeAgo(sub.created_at)}</span>
                        {sub.discussion_count > 0 && (
                          <span>{sub.discussion_count} comment{sub.discussion_count !== 1 ? "s" : ""}</span>
                        )}
                        {sub.audit_cost_usd != null && (
                          <span>${Number(sub.audit_cost_usd).toFixed(4)}</span>
                        )}
                      </div>
                    </div>
                    {sub.audit_result && (
                      <AuditBadge result={sub.audit_result as Record<string, string>} />
                    )}
                  </div>
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Detail slide-over */}
      {selected && (
        <SubmissionDetail
          submission={selected}
          onClose={() => setSelectedId(null)}
          onRefresh={fetchSubmissions}
        />
      )}
    </div>
  );
}

function AuditBadge({ result }: { result: Record<string, unknown> }) {
  const rec = result.recommendation as string;
  const overallScore = result.overall_score as number | undefined;
  const colors: Record<string, string> = {
    accept: "text-emerald-400",
    discuss: "text-blue-400",
    reject: "text-red-400",
    defer: "text-amber-400",
  };
  return (
    <div className="flex items-center gap-1.5 flex-shrink-0">
      {overallScore != null && (
        <span className={`text-xs font-bold ${overallScore >= 7 ? "text-emerald-400" : overallScore >= 4 ? "text-yellow-400" : "text-red-400"}`}>
          {overallScore}/10
        </span>
      )}
      <span className={`text-xs ${colors[rec] || "text-zinc-400"}`}>
        {rec || "—"}
      </span>
    </div>
  );
}
