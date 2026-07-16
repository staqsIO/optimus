"use client";

import { useState, useEffect } from "react";
import AuditResults from "./AuditResults";

interface Submission {
  id: string;
  title: string;
  content_type: string;
  source_format: string;
  submitted_by: string;
  status: string;
  impact_level: string | null;
  urgency: string | null;
  raw_content?: string;
  source_url?: string;
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
}

interface LinkedWorkItem {
  id: string;
  title: string;
  status: string;
  assigned_to: string | null;
  created_at: string;
  updated_at: string;
}

const WORK_STATUS_STYLES: Record<string, string> = {
  created: "bg-zinc-500/20 text-zinc-300",
  assigned: "bg-blue-500/20 text-blue-300",
  in_progress: "bg-purple-500/20 text-purple-300",
  review: "bg-amber-500/20 text-amber-300",
  completed: "bg-emerald-500/20 text-emerald-300",
  failed: "bg-red-500/20 text-red-300",
  cancelled: "bg-zinc-500/20 text-zinc-400",
};

interface Props {
  submission: Submission;
  onClose: () => void;
  onRefresh: () => void;
}

export default function SubmissionDetail({ submission, onClose, onRefresh }: Props) {
  const [deciding, setDeciding] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [showRejectInput, setShowRejectInput] = useState(false);
  const [discussMessage, setDiscussMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fullSubmission, setFullSubmission] = useState<Submission | null>(null);
  const [linkedWork, setLinkedWork] = useState<LinkedWorkItem | null>(null);
  const [requestingReview, setRequestingReview] = useState(false);

  // Fetch full submission details (with raw_content) on mount
  useEffect(() => {
    fetch(`/api/governance/${submission.id}?detail=true`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data) setFullSubmission(data); })
      .catch(() => {});
  }, [submission.id]);

  // Fetch linked work item status if accepted
  useEffect(() => {
    const wid = fullSubmission?.work_item_id || submission.work_item_id;
    if (!wid) return;
    fetch(`/api/governance?path=/api/governance/work-item&id=${wid}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data) setLinkedWork(data); })
      .catch(() => {});
  }, [fullSubmission?.work_item_id, submission.work_item_id]);

  async function handleRequestReview() {
    setRequestingReview(true);
    try {
      await fetch(`/api/governance/${submission.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "discuss",
          message: "Requesting co-founder review on this submission.",
          author: "board",
        }),
      });
      onRefresh();
    } catch {}
    setRequestingReview(false);
  }

  const sub = fullSubmission || submission;
  const isDecidable = ["awaiting_review", "discussing"].includes(sub.status);

  async function handleDecide(decision: string, reason?: string) {
    setDeciding(true);
    setError(null);
    try {
      const res = await fetch(`/api/governance/${sub.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "decide", decision, reason }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Failed: ${res.status}`);
      }
      onRefresh();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setDeciding(false);
    }
  }

  async function handleDiscuss() {
    if (!discussMessage.trim()) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/governance/${sub.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "discuss", message: discussMessage.trim() }),
      });
      if (!res.ok) throw new Error(`Failed: ${res.status}`);
      setDiscussMessage("");
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/60 z-40" onClick={onClose} />

      {/* Slide-over panel */}
      <div className="fixed inset-y-0 right-0 z-50 w-[600px] max-w-[90vw] bg-zinc-900 border-l border-white/10 shadow-2xl overflow-y-auto">
        <div className="p-6 space-y-6">
          {/* Header */}
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-lg font-medium text-zinc-100">{sub.title}</h2>
              <div className="flex items-center gap-2 mt-1 text-xs text-zinc-500">
                <span>{sub.content_type.replace(/_/g, " ")}</span>
                <span>by {sub.submitted_by}</span>
                <span>{new Date(sub.created_at).toLocaleDateString()}</span>
              </div>
            </div>
            <button
              onClick={onClose}
              className="text-zinc-500 hover:text-zinc-300 transition-colors text-lg"
            >
              &times;
            </button>
          </div>

          {/* Classification badges */}
          <div className="flex flex-wrap gap-1.5">
            {sub.spec_domains?.map((d) => (
              <span key={d} className="px-2 py-0.5 text-[10px] bg-cyan-500/10 text-cyan-300 rounded-full border border-cyan-500/20">
                {d}
              </span>
            ))}
            {sub.affected_adrs?.map((a) => (
              <span key={a} className="px-2 py-0.5 text-[10px] bg-amber-500/10 text-amber-300 rounded-full border border-amber-500/20">
                {a}
              </span>
            ))}
            {sub.impact_level && (
              <span className="px-2 py-0.5 text-[10px] bg-white/5 text-zinc-300 rounded-full border border-white/10">
                Impact: {sub.impact_level}
              </span>
            )}
            {sub.urgency && (
              <span className="px-2 py-0.5 text-[10px] bg-white/5 text-zinc-300 rounded-full border border-white/10">
                Urgency: {sub.urgency}
              </span>
            )}
          </div>

          {/* Audit Results + Extraction Cards */}
          {sub.audit_result && (
            <AuditResults
              result={sub.audit_result}
              costUsd={sub.audit_cost_usd}
              extractionsConfirmed={sub.status === "accepted" || sub.status === "deferred"}
              onConfirmExtractions={
                sub.status === "awaiting_review" || sub.status === "discussing"
                  ? async (confirmedIds, dismissedIds) => {
                      const res = await fetch(`/api/governance/${sub.id}`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          action: "confirm-extractions",
                          confirmedIds,
                          dismissedIds,
                        }),
                      });
                      if (res.ok) onRefresh?.();
                    }
                  : undefined
              }
            />
          )}

          {/* Content */}
          {sub.raw_content && (
            <div>
              <h3 className="text-xs font-medium text-zinc-400 mb-2">Content</h3>
              <div className="p-4 bg-zinc-800/50 rounded-lg border border-white/5 text-sm text-zinc-300 whitespace-pre-wrap max-h-80 overflow-y-auto">
                {sub.raw_content}
              </div>
            </div>
          )}

          {sub.source_url && (
            <div>
              <h3 className="text-xs font-medium text-zinc-400 mb-1">Source URL</h3>
              <a href={sub.source_url} target="_blank" rel="noopener noreferrer" className="text-sm text-accent-bright hover:underline break-all">
                {sub.source_url}
              </a>
            </div>
          )}

          {/* Decision info + linked work item */}
          {sub.decision_by && (
            <div className="p-4 bg-zinc-800/50 rounded-lg border border-white/5 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-medium text-zinc-400">Decision</h3>
                <span className="text-[10px] text-zinc-500">
                  {sub.decision_at ? new Date(sub.decision_at).toLocaleDateString() : ""}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className={`px-2 py-0.5 text-xs rounded-full ${
                  sub.status === "accepted" ? "bg-emerald-500/20 text-emerald-300" :
                  sub.status === "rejected" ? "bg-red-500/20 text-red-300" :
                  sub.status === "deferred" ? "bg-amber-500/20 text-amber-300" :
                  "bg-zinc-500/20 text-zinc-300"
                }`}>
                  {sub.status}
                </span>
                <span className="text-xs text-zinc-500">by {sub.decision_by}</span>
              </div>
              {sub.decision_reason && (
                <p className="text-sm text-zinc-300">{sub.decision_reason}</p>
              )}

              {/* Linked work item tracker */}
              {linkedWork && (
                <div className="mt-2 p-3 bg-zinc-900/50 rounded-lg border border-white/5">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] text-zinc-500 uppercase tracking-wide">Linked Work Item</span>
                    <span className={`px-2 py-0.5 text-[10px] rounded-full ${WORK_STATUS_STYLES[linkedWork.status] || "bg-zinc-500/20 text-zinc-300"}`}>
                      {linkedWork.status.replace(/_/g, " ")}
                    </span>
                  </div>
                  <p className="text-sm text-zinc-300 truncate">{linkedWork.title}</p>
                  <div className="flex items-center gap-3 mt-1 text-[11px] text-zinc-500">
                    {linkedWork.assigned_to && <span>Assigned: {linkedWork.assigned_to}</span>}
                    <span>ID: {linkedWork.id.slice(0, 8)}</span>
                  </div>
                </div>
              )}

              {sub.pr_url && (
                <a href={sub.pr_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-xs text-accent-bright hover:underline mt-1">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                  View PR
                </a>
              )}
            </div>
          )}

          {/* Discussion thread */}
          <div>
            <h3 className="text-xs font-medium text-zinc-400 mb-2">
              Discussion {sub.discussion_thread?.length > 0 && `(${sub.discussion_thread.length})`}
            </h3>
            {sub.discussion_thread?.length > 0 ? (
              <div className="space-y-3 mb-3">
                {sub.discussion_thread.map((msg, i) => (
                  <div key={i} className="p-3 bg-zinc-800/30 rounded-lg border border-white/5">
                    <div className="flex items-center gap-2 mb-1 text-[11px] text-zinc-500">
                      <span className="font-medium text-zinc-400">{msg.author}</span>
                      <span>{new Date(msg.created_at).toLocaleString()}</span>
                    </div>
                    <p className="text-sm text-zinc-300">
                      {msg.message.split(/(@\w+)/g).map((part, j) =>
                        /^@\w+/.test(part) ? (
                          <span key={j} className="text-blue-400 font-medium">{part}</span>
                        ) : (
                          <span key={j}>{part}</span>
                        )
                      )}
                    </p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-zinc-600 mb-3">No discussion yet</p>
            )}

            {/* Add comment */}
            {isDecidable && (
              <div className="flex gap-2">
                <input
                  type="text"
                  value={discussMessage}
                  onChange={(e) => setDiscussMessage(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleDiscuss(); }}
                  placeholder="Add to discussion... (@dustin, @eric to mention)"
                  className="flex-1 px-3 py-2 text-sm bg-zinc-800 border border-white/10 rounded-lg text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-accent/50"
                  disabled={sending}
                />
                <button
                  onClick={handleDiscuss}
                  disabled={sending || !discussMessage.trim()}
                  className="px-4 py-2 text-sm bg-zinc-800 text-zinc-300 rounded-lg hover:bg-zinc-700 transition-colors disabled:opacity-40"
                >
                  {sending ? "..." : "Send"}
                </button>
                <button
                  onClick={handleRequestReview}
                  disabled={requestingReview}
                  className="px-3 py-2 text-sm bg-blue-500/20 text-blue-300 rounded-lg hover:bg-blue-500/30 transition-colors disabled:opacity-40"
                  title="Request co-founder review"
                >
                  {requestingReview ? "..." : "Request Review"}
                </button>
              </div>
            )}
          </div>

          {/* Error */}
          {error && (
            <div className="px-4 py-2 text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg">
              {error}
            </div>
          )}

          {/* Action bar */}
          {isDecidable && (
            <div className="border-t border-white/5 pt-4 space-y-3">
              {showRejectInput ? (
                <div className="space-y-2">
                  <input
                    type="text"
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    placeholder="Reason for rejection (required)"
                    className="w-full px-3 py-2 text-sm bg-zinc-800 border border-white/10 rounded-lg text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-red-500/50"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleDecide("rejected", rejectReason)}
                      disabled={deciding || !rejectReason.trim()}
                      className="px-4 py-2 text-sm bg-red-500/20 text-red-300 rounded-lg hover:bg-red-500/30 transition-colors disabled:opacity-40"
                    >
                      Confirm Reject
                    </button>
                    <button
                      onClick={() => { setShowRejectInput(false); setRejectReason(""); }}
                      className="px-4 py-2 text-sm bg-zinc-800 text-zinc-400 rounded-lg hover:bg-zinc-700 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleDecide("accepted")}
                      disabled={deciding}
                      className="flex-1 px-4 py-2 text-sm bg-emerald-500/20 text-emerald-300 rounded-lg hover:bg-emerald-500/30 transition-colors disabled:opacity-40"
                    >
                      {deciding ? "..." : "Accept"}
                    </button>
                    <button
                      onClick={() => setShowRejectInput(true)}
                      disabled={deciding}
                      className="flex-1 px-4 py-2 text-sm bg-red-500/20 text-red-300 rounded-lg hover:bg-red-500/30 transition-colors disabled:opacity-40"
                    >
                      Reject
                    </button>
                    <button
                      onClick={() => handleDecide("deferred")}
                      disabled={deciding}
                      className="flex-1 px-4 py-2 text-sm bg-amber-500/20 text-amber-300 rounded-lg hover:bg-amber-500/30 transition-colors disabled:opacity-40"
                    >
                      Defer
                    </button>
                  </div>
                  {/* Accept + PR: route through prompt-to-PR pipeline */}
                  {(sub.content_type === "spec_amendment" || sub.content_type === "adr" || sub.content_type === "process_improvement") && (
                    <button
                      onClick={() => {
                        // Accept and redirect to workstation with content pre-loaded
                        handleDecide("accepted").then(() => {
                          const prompt = encodeURIComponent(
                            `Implement governance submission: ${sub.title}\n\n${sub.raw_content || sub.decision_reason || ""}`
                          );
                          window.location.href = `/workstation?chip=change&prompt=${prompt}`;
                        });
                      }}
                      disabled={deciding}
                      className="w-full px-4 py-2 text-sm bg-purple-500/20 text-purple-300 rounded-lg hover:bg-purple-500/30 transition-colors disabled:opacity-40"
                    >
                      {deciding ? "..." : "Accept + Open in Workstation"}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
