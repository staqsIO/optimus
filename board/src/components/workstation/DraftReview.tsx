"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { opsFetch, opsPost } from "@/lib/ops-api";

interface DraftReviewProps {
  open: boolean;
  onClose: () => void;
}

interface Draft {
  id: string;
  body: string;
  subject: string;
  to_addresses: string[];
  email_summary: string;
  draft_intent: string;
  reviewer_verdict: string;
  tone_score: number | null;
  created_at: string;
  emails: {
    from_address: string;
    from_name: string;
    subject: string;
    triage_category: string;
    snippet: string;
    received_at: string;
    priority_score: number;
    channel: string;
    account_label: string;
  };
}

export default function DraftReview({ open, onClose }: DraftReviewProps) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionInFlight, setActionInFlight] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedDraft, setExpandedDraft] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const fetchDrafts = useCallback(async () => {
    setLoading(true);
    const data = await opsFetch<{ drafts: Draft[] }>("/api/drafts");
    setDrafts(data?.drafts ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (open) {
      setError(null);
      setExpandedDraft(null);
      fetchDrafts();
      closeRef.current?.focus();
    }
  }, [open, fetchDrafts]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  const handleAction = useCallback(
    async (id: string, action: "approve" | "reject" | "send") => {
      if (actionInFlight) return;
      setActionInFlight(id);
      setError(null);

      const endpoint =
        action === "approve"
          ? "/api/drafts/approve"
          : action === "reject"
            ? "/api/drafts/reject"
            : "/api/drafts/send";

      const result = await opsPost(endpoint, { id });
      if (!result.ok) {
        setError(`Failed to ${action}: ${result.error}`);
        setActionInFlight(null);
        return;
      }

      setDrafts((prev) => prev.filter((d) => d.id !== id));
      setActionInFlight(null);
      await fetchDrafts();
    },
    [actionInFlight, fetchDrafts],
  );

  const verdictColor = (verdict: string) => {
    if (verdict === "approved") return "text-emerald-400 bg-emerald-400/10 border-emerald-400/20";
    if (verdict === "rejected") return "text-red-400 bg-red-400/10 border-red-400/20";
    return "text-zinc-400 bg-zinc-400/10 border-zinc-400/20";
  };

  const toneColor = (score: number) => {
    if (score >= 0.8) return "text-emerald-400 bg-emerald-400/10 border-emerald-400/20";
    if (score >= 0.5) return "text-amber-400 bg-amber-400/10 border-amber-400/20";
    return "text-red-400 bg-red-400/10 border-red-400/20";
  };

  if (!open) return null;

  return (
    <>
      <div
        className="fixed inset-0 bg-black/40 z-40"
        onClick={onClose}
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="draft-review-title"
        className="fixed top-0 right-0 h-full w-full sm:w-96 sm:max-w-md bg-surface-raised border-l border-white/10 z-50 flex flex-col"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
          <h2 id="draft-review-title" className="text-sm font-medium text-zinc-200">Pending Drafts</h2>
          <button
            ref={closeRef}
            onClick={onClose}
            aria-label="Close draft review panel"
            className="text-zinc-500 hover:text-zinc-300 transition-colors p-1.5 rounded-md hover:bg-white/5 -mr-1"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {error && (
            <div className="px-3 py-2 text-xs bg-red-500/10 text-red-400 rounded-lg border border-red-500/20" role="alert">
              {error}
            </div>
          )}

          {loading && drafts.length === 0 && (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="bg-surface rounded-lg border border-white/5 p-3 space-y-2 animate-pulse">
                  <div className="h-3 bg-white/5 rounded w-1/3" />
                  <div className="h-4 bg-white/5 rounded w-2/3" />
                  <div className="space-y-1">
                    <div className="h-3 bg-white/5 rounded w-full" />
                    <div className="h-3 bg-white/5 rounded w-4/5" />
                  </div>
                  <div className="flex gap-2 pt-1">
                    <div className="h-6 bg-white/5 rounded w-16" />
                    <div className="h-6 bg-white/5 rounded w-16" />
                  </div>
                </div>
              ))}
            </div>
          )}

          {!loading && drafts.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="w-10 h-10 rounded-full bg-emerald-500/10 flex items-center justify-center mb-3">
                <svg className="w-5 h-5 text-emerald-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
              </div>
              <p className="text-sm text-zinc-400">All caught up</p>
              <p className="text-xs text-zinc-600 mt-1">No drafts need your review right now.</p>
            </div>
          )}

          {drafts.map((draft) => {
            const isActing = actionInFlight === draft.id;
            const isExpanded = expandedDraft === draft.id;
            return (
              <div
                key={draft.id}
                className={`bg-surface rounded-lg border border-white/5 p-3 space-y-2 ${isActing ? "opacity-50" : ""}`}
              >
                <div>
                  <p className="text-xs text-zinc-500 truncate">
                    {draft.emails.from_name || draft.emails.from_address}
                  </p>
                  <p className="text-sm text-zinc-200 font-medium truncate">
                    {draft.emails.subject || draft.subject}
                  </p>
                </div>

                {isExpanded ? (
                  <div className="text-xs text-zinc-300 leading-relaxed whitespace-pre-wrap bg-surface-overlay rounded p-2 border border-white/5 max-h-48 overflow-y-auto">
                    {draft.body}
                  </div>
                ) : (
                  <p className="text-xs text-zinc-400 leading-relaxed line-clamp-3">
                    {draft.body}
                  </p>
                )}
                {draft.body?.length > 100 && (
                  <button
                    onClick={() => setExpandedDraft(isExpanded ? null : draft.id)}
                    className="text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
                  >
                    {isExpanded ? "Show less" : "Read full draft"}
                  </button>
                )}

                <div className="flex items-center gap-1.5 flex-wrap">
                  {draft.tone_score != null && (
                    <span
                      className={`inline-flex items-center px-1.5 py-0.5 text-[10px] rounded border ${toneColor(Number(draft.tone_score))}`}
                    >
                      tone: {Number(draft.tone_score).toFixed(2)}
                    </span>
                  )}
                  <span
                    className={`inline-flex items-center px-1.5 py-0.5 text-[10px] rounded border ${verdictColor(draft.reviewer_verdict)}`}
                  >
                    {draft.reviewer_verdict}
                  </span>
                  <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] rounded border border-white/10 text-zinc-400 bg-white/5">
                    {draft.emails.channel}
                  </span>
                </div>

                <div className="flex items-center justify-between pt-1">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleAction(draft.id, "approve")}
                      disabled={!!actionInFlight}
                      className="px-2.5 py-1.5 text-xs rounded-md bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 transition-colors border border-emerald-500/20 disabled:opacity-40 disabled:cursor-not-allowed min-h-[32px]"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => handleAction(draft.id, "reject")}
                      disabled={!!actionInFlight}
                      className="px-2.5 py-1.5 text-xs rounded-md bg-red-500/15 text-red-400 hover:bg-red-500/25 transition-colors border border-red-500/20 disabled:opacity-40 disabled:cursor-not-allowed min-h-[32px]"
                    >
                      Reject
                    </button>
                  </div>
                  <button
                    onClick={() => handleAction(draft.id, "send")}
                    disabled={!!actionInFlight}
                    className="px-3 py-1.5 text-xs rounded-md bg-accent text-white hover:bg-accent-dim transition-colors font-medium disabled:opacity-40 disabled:cursor-not-allowed min-h-[32px]"
                  >
                    Send
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
