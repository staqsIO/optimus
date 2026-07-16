"use client";

import { useState, useEffect, useCallback } from "react";
import { opsFetch, opsPost } from "@/lib/ops-api";

interface ProposalReply {
  id: string;
  proposal_id: string;
  actor: "board" | "signer";
  actor_display: string | null;
  message: string;
  created_at: string;
}

interface Proposal {
  id: string;
  proposal_type: "comment" | "redline";
  quoted_text: string | null;
  proposed_text: string | null;
  note: string | null;
  status: "open" | "accepted" | "dismissed" | "superseded";
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  applied_version_id: string | null;
  draft_version_id: string | null;
  created_at: string;
  signer_name: string;
  signer_email: string;
  replies?: ProposalReply[];
}

interface ContractProposalsProps {
  contractId: string;
  /** Fires after an accept/dismiss so the parent can reload the draft list, body, etc. */
  onResolved?: (wasAccept: boolean, revokedRequest: boolean) => void;
  refreshKey?: number;
}

const STATUS_BADGE: Record<Proposal["status"], { label: string; className: string }> = {
  open:       { label: "open",       className: "bg-amber-500/15 text-amber-300 border-amber-500/30" },
  accepted:   { label: "accepted",   className: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" },
  dismissed:  { label: "dismissed",  className: "bg-zinc-700/50 text-zinc-400 border-zinc-700" },
  superseded: { label: "superseded", className: "bg-zinc-700/50 text-zinc-500 border-zinc-700" },
};

export default function ContractProposals({ contractId, onResolved, refreshKey = 0 }: ContractProposalsProps) {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [sendingReply, setSendingReply] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!contractId) return;
    setLoading(true);
    try {
      const data = await opsFetch<{ proposals: Proposal[] }>(`/api/contracts/${contractId}/proposals`);
      setProposals(data?.proposals || []);
    } finally {
      setLoading(false);
    }
  }, [contractId]);

  useEffect(() => { load(); }, [load, refreshKey]);

  async function accept(p: Proposal) {
    if (p.proposal_type === "redline") {
      const ok = window.confirm(
        `Apply this redline and revoke the current signing request?\n\n` +
        `The body will be updated and the in-flight signatures will be cancelled.`
      );
      if (!ok) return;
    }
    let autoResend = false;
    if (p.proposal_type === "redline") {
      autoResend = window.confirm(
        `Auto-resend the contract to the same signers once applied?\n\n` +
        `New signing links will be generated and emailed immediately. ` +
        `Cancel if you want to review what else changed first and send manually.`
      );
    }
    setActingId(p.id);
    setError(null);
    try {
      const attemptAccept = async (reconcile: boolean) =>
        opsPost<{
          revoked_request: boolean;
          fuzzy_reconcile: boolean;
          new_request: { request_id?: string; error?: string; signer_count?: number } | null;
        }>(
          `/api/contracts/${contractId}/proposals/${p.id}/accept`,
          { auto_resend: autoResend, reconcile }
        );

      let result = await attemptAccept(false);

      // 409 with suggest_reconcile — quoted section doesn't appear verbatim.
      // Offer to retry via LLM fuzzy reconcile.
      if (
        !result.ok &&
        typeof result.error === "string" &&
        result.error.toLowerCase().includes("quoted text no longer")
      ) {
        const retry = window.confirm(
          `The text this signer quoted no longer appears in the contract — ` +
          `someone edited around it after they viewed it.\n\n` +
          `Ask the model to integrate the change into the current body instead? ` +
          `You should verify the result in the editor before sending.`
        );
        if (retry) {
          result = await attemptAccept(true);
        }
      }

      if (result.ok) {
        const newReq = result.data?.new_request;
        if (newReq?.error) {
          setError(`Applied, but auto-resend failed: ${newReq.error}`);
        } else if (newReq?.request_id) {
          // Success — parent will reload and pick up the new signing request
        }
        onResolved?.(true, !!result.data?.revoked_request);
        await load();
      } else {
        setError(result.error || "Accept failed");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActingId(null);
    }
  }

  async function sendReply(p: Proposal) {
    const msg = (replyDrafts[p.id] || "").trim();
    if (!msg) return;
    setSendingReply(p.id);
    setError(null);
    try {
      const result = await opsPost(
        `/api/contracts/${contractId}/proposals/${p.id}/reply`,
        { message: msg }
      );
      if (result.ok) {
        setReplyDrafts((d) => ({ ...d, [p.id]: "" }));
        await load();
      } else {
        setError(result.error || "Reply failed");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSendingReply(null);
    }
  }

  async function dismiss(p: Proposal) {
    const note = window.prompt("Reason for dismissing (optional):") || null;
    setActingId(p.id);
    setError(null);
    try {
      const result = await opsPost(
        `/api/contracts/${contractId}/proposals/${p.id}/dismiss`,
        { note }
      );
      if (result.ok) {
        onResolved?.(false, false);
        await load();
      } else {
        setError(result.error || "Dismiss failed");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActingId(null);
    }
  }

  const open = proposals.filter((p) => p.status === "open");
  const resolved = proposals.filter((p) => p.status !== "open");

  if (proposals.length === 0 && !loading) return null;

  return (
    <div className="border-b border-zinc-800 bg-amber-500/5">
      <div className="px-4 py-3">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold text-amber-200 flex items-center gap-2">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            Signer proposals
            {open.length > 0 && (
              <span className="px-1.5 py-0.5 text-[9px] font-semibold rounded bg-amber-500 text-zinc-900">
                {open.length} open
              </span>
            )}
          </h3>
          {resolved.length > 0 && (
            <button
              onClick={() => setShowResolved((v) => !v)}
              className="text-[10px] text-zinc-500 hover:text-zinc-300"
            >
              {showResolved ? "Hide" : `Show ${resolved.length} resolved`}
            </button>
          )}
        </div>

        {error && (
          <div className="mb-2 px-2 py-1.5 rounded bg-red-500/10 border border-red-500/20 text-[10px] text-red-300">
            {error}
          </div>
        )}

        <ul className="space-y-2">
          {[...open, ...(showResolved ? resolved : [])].map((p) => (
            <li
              key={p.id}
              className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3"
            >
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`px-1.5 py-0.5 text-[9px] font-medium rounded border ${STATUS_BADGE[p.status].className}`}>
                    {STATUS_BADGE[p.status].label}
                  </span>
                  <span className={`px-1.5 py-0.5 text-[9px] font-medium rounded ${
                    p.proposal_type === "redline" ? "bg-violet-500/15 text-violet-300" : "bg-sky-500/15 text-sky-300"
                  }`}>
                    {p.proposal_type}
                  </span>
                  <span className="text-[11px] text-zinc-300 truncate">{p.signer_name}</span>
                  <span className="text-[10px] text-zinc-600 shrink-0">{new Date(p.created_at).toLocaleString()}</span>
                </div>
                {p.status === "open" && (
                  <div className="flex gap-1 shrink-0">
                    <button
                      onClick={() => accept(p)}
                      disabled={actingId === p.id}
                      className="px-2 py-1 text-[10px] font-medium rounded bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50"
                    >
                      {actingId === p.id ? "..." : "Accept"}
                    </button>
                    <button
                      onClick={() => dismiss(p)}
                      disabled={actingId === p.id}
                      className="px-2 py-1 text-[10px] font-medium rounded bg-zinc-800 text-zinc-300 hover:bg-red-500/30 hover:text-red-200 disabled:opacity-50"
                    >
                      Dismiss
                    </button>
                  </div>
                )}
              </div>

              {p.quoted_text && (
                <div className="mb-2">
                  <div className="text-[9px] font-semibold text-zinc-500 uppercase tracking-wide mb-0.5">
                    Section of the document
                  </div>
                  <pre className="text-[11px] text-zinc-300 bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 whitespace-pre-wrap break-words font-mono max-h-[120px] overflow-y-auto">
                    {p.quoted_text}
                  </pre>
                </div>
              )}

              {p.proposal_type === "redline" && p.proposed_text !== null && (
                <div className="mb-2">
                  <div className="text-[9px] font-semibold text-emerald-500 uppercase tracking-wide mb-0.5">
                    Suggested replacement
                  </div>
                  <pre className="text-[11px] text-emerald-100 bg-emerald-500/5 border border-emerald-500/20 rounded px-2 py-1.5 whitespace-pre-wrap break-words font-mono max-h-[120px] overflow-y-auto">
                    {p.proposed_text}
                  </pre>
                </div>
              )}

              {p.note && (
                <div className="text-[11px] text-zinc-400 italic leading-snug">“{p.note}”</div>
              )}

              {/* Thread — inline reply history + (if still open) composer */}
              {(p.replies && p.replies.length > 0) && (
                <ul className="mt-2 space-y-1.5">
                  {p.replies.map((r) => (
                    <li
                      key={r.id}
                      className={`rounded border px-2.5 py-1.5 ${
                        r.actor === "board"
                          ? "border-sky-500/30 bg-sky-500/5"
                          : "border-zinc-700 bg-zinc-900/50"
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className={`text-[9px] font-medium ${
                          r.actor === "board" ? "text-sky-300" : "text-zinc-400"
                        }`}>
                          {r.actor_display || r.actor} · {r.actor}
                        </span>
                        <span className="text-[9px] text-zinc-600">
                          {new Date(r.created_at).toLocaleString()}
                        </span>
                      </div>
                      <div className="text-[11px] text-zinc-300 whitespace-pre-wrap break-words">
                        {r.message}
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              {p.status === "open" && (
                <div className="mt-2 flex items-end gap-2">
                  <textarea
                    value={replyDrafts[p.id] || ""}
                    onChange={(e) => setReplyDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
                    placeholder="Reply — signer will be emailed"
                    rows={2}
                    className="flex-1 px-2 py-1.5 text-[11px] bg-zinc-900 border border-zinc-800 rounded resize-none text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-sky-500/40"
                  />
                  <button
                    onClick={() => sendReply(p)}
                    disabled={sendingReply === p.id || !(replyDrafts[p.id] || "").trim()}
                    className="px-2.5 py-1.5 text-[10px] font-medium rounded bg-sky-600 text-white hover:bg-sky-500 disabled:bg-zinc-800 disabled:text-zinc-600 shrink-0"
                  >
                    {sendingReply === p.id ? "..." : "Reply"}
                  </button>
                </div>
              )}

              {p.status !== "open" && (
                <div className="mt-2 pt-2 border-t border-zinc-800/50 text-[10px] text-zinc-500">
                  {p.status} by {p.resolved_by || "?"}
                  {p.resolved_at && ` · ${new Date(p.resolved_at).toLocaleString()}`}
                  {p.resolution_note && <span className="block mt-0.5 italic">“{p.resolution_note}”</span>}
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
