"use client";

import { useCallback, useEffect, useState } from "react";
import AuthorWorkRequestForm from "./AuthorWorkRequestForm";

/**
 * Hub Wedge B render-back + Wedge C review-binding. Shows every human-authored
 * request and where it is in its lifecycle (the glass pipeline, scoped to authored
 * work). Once a request has become a work_item, the board marks each acceptance
 * criterion pass/fail here — the verdict against the author's own contract.
 * "Reconciled" = every criterion passed. Raw statuses are mapped to legible stages
 * HERE (vocabulary is a render concern).
 */

type CriterionResult = "pass" | "fail" | null;

interface Criterion {
  text: string;
  result: CriterionResult;
}

interface Contract {
  outcome: string;
  criteria: Criterion[];
  out_of_scope: string[];
  authored_by?: string;
  pattern?: string | null;
  verified_by?: string;
  verified_at?: string;
}

interface AuthoredRequest {
  intent_id: string;
  title: string;
  intent_status: string;
  outcome: string;
  created_at: string;
  contract: Contract | null;
  work_item_id: string | null;
  work_item_status: string | null;
  work_item_contract: Contract | null;
  work_item_updated_at: string | null;
}

interface Stage {
  label: string;
  cls: string;
}

/** Map raw intent + work_item status to a legible lifecycle stage. */
function lifecycleStage(r: AuthoredRequest): Stage {
  if (r.intent_status === "pending") {
    return { label: "Awaiting board review", cls: "bg-amber-500/15 text-amber-300 border-amber-500/30" };
  }
  if (r.intent_status === "rejected") {
    return { label: "Sent back", cls: "bg-red-500/15 text-red-300 border-red-500/30" };
  }
  if (r.intent_status === "expired") {
    return { label: "Expired", cls: "bg-zinc-600/20 text-zinc-400 border-white/10" };
  }
  // executed -> follow the work_item
  switch (r.work_item_status) {
    case "created":
    case "assigned":
      return { label: "Queued", cls: "bg-sky-500/15 text-sky-300 border-sky-500/30" };
    case "in_progress":
      return { label: "Building", cls: "bg-blue-500/15 text-blue-300 border-blue-500/30" };
    case "review":
      return { label: "In review", cls: "bg-violet-500/15 text-violet-300 border-violet-500/30" };
    case "completed":
      return { label: "Shipped", cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" };
    case "failed":
    case "blocked":
    case "timed_out":
      return { label: "Needs attention", cls: "bg-red-500/15 text-red-300 border-red-500/30" };
    case "cancelled":
      return { label: "Cancelled", cls: "bg-zinc-600/20 text-zinc-400 border-white/10" };
    case null:
      // Approved, but the work_item hasn't been created yet (transient handoff).
      return { label: "Queued", cls: "bg-sky-500/15 text-sky-300 border-sky-500/30" };
    default:
      // Unknown/unexpected work_item status — neutral, never emerald.
      return { label: "Approved", cls: "bg-zinc-600/20 text-zinc-300 border-white/10" };
  }
}

function isReconciled(c: Contract | null): boolean {
  return !!c && c.criteria.length > 0 && c.criteria.every((x) => x.result === "pass");
}

function CriterionRow({
  c,
  onMark,
  busy,
}: {
  c: Criterion;
  onMark?: (result: CriterionResult) => void;
  busy: boolean;
}) {
  const mark = c.result === "pass" ? "✓" : c.result === "fail" ? "✗" : "○";
  const markCls =
    c.result === "pass" ? "text-emerald-400" : c.result === "fail" ? "text-red-400" : "text-zinc-600";

  return (
    <li className="flex gap-2 text-xs text-zinc-300 items-start">
      <span className={`${markCls} mt-0.5`} aria-hidden>{mark}</span>
      <span className="flex-1">{c.text}</span>
      {onMark && (
        <span className="flex gap-1 shrink-0">
          <button
            disabled={busy}
            onClick={() => onMark(c.result === "pass" ? null : "pass")}
            className={`px-1.5 rounded text-[11px] border transition-colors disabled:opacity-40 ${
              c.result === "pass"
                ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
                : "text-zinc-500 border-white/10 hover:text-emerald-300 hover:border-emerald-500/30"
            }`}
            aria-label="Mark pass"
          >
            pass
          </button>
          <button
            disabled={busy}
            onClick={() => onMark(c.result === "fail" ? null : "fail")}
            className={`px-1.5 rounded text-[11px] border transition-colors disabled:opacity-40 ${
              c.result === "fail"
                ? "bg-red-500/20 text-red-300 border-red-500/40"
                : "text-zinc-500 border-white/10 hover:text-red-300 hover:border-red-500/30"
            }`}
            aria-label="Mark fail"
          >
            fail
          </button>
        </span>
      )}
    </li>
  );
}

export default function AuthoredRequestsPanel() {
  const [requests, setRequests] = useState<AuthoredRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyItem, setBusyItem] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/governance/work-requests");
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Failed: ${res.status}`);
      }
      const data = await res.json();
      setRequests(Array.isArray(data.requests) ? data.requests : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load requests");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const verify = useCallback(
    async (workItemId: string, index: number, result: CriterionResult) => {
      setBusyItem(workItemId);
      setError(null);
      try {
        const res = await fetch("/api/governance/work-requests/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workItemId, results: [{ index, result }] }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `Failed: ${res.status}`);
        }
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to record verdict");
      } finally {
        setBusyItem(null);
      }
    },
    [load]
  );

  return (
    <div className="space-y-4">
      <AuthorWorkRequestForm onSubmitted={load} />

      {loading && <div className="text-xs text-zinc-500">Loading requests…</div>}
      {error && <div className="text-xs text-red-400">{error}</div>}

      {!loading && !error && requests.length === 0 && (
        <div className="text-xs text-zinc-500">
          No requests yet. Author one above — describe the outcome and the checks that prove it.
        </div>
      )}

      <ul className="space-y-3">
        {requests.map((r) => {
          const stage = lifecycleStage(r);
          // Once a work_item exists, mark criteria against the live work_item contract.
          const verifiable = !!r.work_item_id && !!r.work_item_contract?.criteria?.length;
          const contract = r.work_item_contract || r.contract;
          const reconciled = verifiable && isReconciled(r.work_item_contract);
          const busy = busyItem === r.work_item_id;
          const workItemId = r.work_item_id;

          return (
            <li
              key={r.intent_id}
              className="p-4 bg-zinc-800/40 rounded-lg border border-white/10 space-y-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h4 className="text-sm font-medium text-zinc-200 truncate">{r.title}</h4>
                  <p className="text-xs text-zinc-400 mt-0.5">{contract?.outcome || r.outcome}</p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {reconciled && (
                    <span className="px-2 py-0.5 text-[11px] rounded-full border bg-emerald-500/15 text-emerald-300 border-emerald-500/40">
                      Reconciled
                    </span>
                  )}
                  <span className={`px-2 py-0.5 text-[11px] rounded-full border ${stage.cls}`}>
                    {stage.label}
                  </span>
                </div>
              </div>

              {contract?.criteria?.length ? (
                <div>
                  <div className="text-[11px] text-zinc-500 mb-1">
                    Acceptance criteria{verifiable ? " — mark each pass/fail" : ""}
                  </div>
                  <ul className="space-y-1">
                    {contract.criteria.map((c, i) => (
                      <CriterionRow
                        key={c.text}
                        c={c}
                        busy={busy}
                        onMark={
                          verifiable && workItemId
                            ? (result) => verify(workItemId, i, result)
                            : undefined
                        }
                      />
                    ))}
                  </ul>
                </div>
              ) : null}

              {contract?.out_of_scope?.length ? (
                <div className="text-[11px] text-zinc-500">
                  Out of scope: {contract.out_of_scope.join("; ")}
                </div>
              ) : null}

              <div className="flex justify-between text-[10px] text-zinc-600">
                {contract?.authored_by && <span>authored by {contract.authored_by}</span>}
                {r.work_item_contract?.verified_by && (
                  <span>verified by {r.work_item_contract.verified_by}</span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
