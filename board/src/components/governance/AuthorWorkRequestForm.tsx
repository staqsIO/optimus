"use client";

import { useState, useCallback } from "react";

/**
 * Hub Wedge B — author a work request at outcome + acceptance-criteria altitude.
 *
 * A non-technical author describes WHAT should be true (outcome), the binary
 * pass/fail checks that prove it (criteria), and what is explicitly NOT in scope.
 * No prose spec, no code. The same governed agent teams execute it; the criteria
 * are the contract they are graded against. Final enforcement is backend-side (P2);
 * the client checks are only to guide before submit.
 */

const MIN_CRITERIA = 3;
const MAX_CRITERIA = 7;

interface AuthorWorkRequestFormProps {
  onSubmitted: () => void;
}

export default function AuthorWorkRequestForm({ onSubmitted }: AuthorWorkRequestFormProps) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [outcome, setOutcome] = useState("");
  const [criteria, setCriteria] = useState<string[]>(["", "", ""]);
  const [outOfScope, setOutOfScope] = useState<string[]>([""]);
  const [pattern, setPattern] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const reset = useCallback(() => {
    setTitle("");
    setOutcome("");
    setCriteria(["", "", ""]);
    setOutOfScope([""]);
    setPattern("");
    setError(null);
  }, []);

  const setAt = (
    arr: string[],
    setArr: (v: string[]) => void,
    i: number,
    v: string
  ) => setArr(arr.map((x, idx) => (idx === i ? v : x)));

  const filledCriteria = criteria.map((c) => c.trim()).filter(Boolean);
  const filledScope = outOfScope.map((s) => s.trim()).filter(Boolean);
  const clientReady =
    title.trim().length >= 3 &&
    outcome.trim().length >= 10 &&
    filledCriteria.length >= MIN_CRITERIA &&
    filledScope.length >= 1;

  const handleSubmit = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch("/api/governance/work-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          outcome: outcome.trim(),
          acceptanceCriteria: criteria.map((c) => c.trim()).filter(Boolean),
          outOfScope: outOfScope.map((s) => s.trim()).filter(Boolean),
          pattern: pattern.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Failed: ${res.status}`);
      }
      reset();
      setOpen(false);
      setSuccess("Request submitted — awaiting board review.");
      setTimeout(() => setSuccess(null), 4000);
      onSubmitted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submission failed");
    } finally {
      setSubmitting(false);
    }
  }, [title, outcome, criteria, outOfScope, pattern, reset, onSubmitted]);

  if (!open) {
    return (
      <div className="space-y-2">
        <button
          onClick={() => setOpen(true)}
          className="px-4 py-2 text-sm bg-accent-bright/20 text-accent-bright rounded-lg hover:bg-accent-bright/30 transition-colors border border-accent-bright/30"
        >
          + Author a request
        </button>
        {success && <div className="text-[11px] text-emerald-400">{success}</div>}
      </div>
    );
  }

  const inputCls =
    "w-full px-3 py-2 text-sm bg-zinc-800 border border-white/10 rounded-lg text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-accent/50";

  return (
    <div className="p-4 bg-zinc-800/50 rounded-lg border border-white/10 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-zinc-200">Author a work request</h3>
        <button
          onClick={() => setOpen(false)}
          className="text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          &times;
        </button>
      </div>

      <p className="text-[11px] text-zinc-500 leading-relaxed">
        Describe what should be true when this is done and the checks that prove it.
        You don&apos;t write code — the agent team does, against these criteria.
      </p>

      <div className="space-y-1">
        <label className="text-xs text-zinc-400">Title</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Short name for the request"
          className={inputCls}
        />
      </div>

      <div className="space-y-1">
        <label className="text-xs text-zinc-400">
          Outcome — what should be true when this is done
        </label>
        <textarea
          value={outcome}
          onChange={(e) => setOutcome(e.target.value)}
          placeholder="A non-technical user can download the contacts list as a CSV from the board."
          rows={2}
          className={`${inputCls} resize-none`}
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs text-zinc-400">
          Acceptance criteria — {MIN_CRITERIA}-{MAX_CRITERIA} binary pass/fail checks
        </label>
        {criteria.map((c, i) => (
          <div key={i} className="flex gap-1.5 items-center">
            <span className="text-[10px] text-zinc-600 w-4 text-right">{i + 1}.</span>
            <input
              type="text"
              value={c}
              onChange={(e) => setAt(criteria, setCriteria, i, e.target.value)}
              placeholder="A concrete, observable condition that is clearly pass or fail"
              className={inputCls}
            />
            {criteria.length > MIN_CRITERIA && (
              <button
                onClick={() => setCriteria(criteria.filter((_, idx) => idx !== i))}
                className="text-zinc-600 hover:text-red-400 transition-colors px-1"
                aria-label="Remove criterion"
              >
                &times;
              </button>
            )}
          </div>
        ))}
        {criteria.length < MAX_CRITERIA && (
          <button
            onClick={() => setCriteria([...criteria, ""])}
            className="text-[11px] text-accent-bright/80 hover:text-accent-bright transition-colors ml-5"
          >
            + add criterion
          </button>
        )}
      </div>

      <div className="space-y-1.5">
        <label className="text-xs text-zinc-400">
          Out of scope — name at least one thing this is NOT
        </label>
        {outOfScope.map((s, i) => (
          <div key={i} className="flex gap-1.5 items-center">
            <input
              type="text"
              value={s}
              onChange={(e) => setAt(outOfScope, setOutOfScope, i, e.target.value)}
              placeholder="Something deliberately excluded"
              className={inputCls}
            />
            {outOfScope.length > 1 && (
              <button
                onClick={() => setOutOfScope(outOfScope.filter((_, idx) => idx !== i))}
                className="text-zinc-600 hover:text-red-400 transition-colors px-1"
                aria-label="Remove out-of-scope item"
              >
                &times;
              </button>
            )}
          </div>
        ))}
        <button
          onClick={() => setOutOfScope([...outOfScope, ""])}
          className="text-[11px] text-accent-bright/80 hover:text-accent-bright transition-colors"
        >
          + add out-of-scope item
        </button>
      </div>

      {error && <div className="text-xs text-red-400">{error}</div>}

      <div className="flex gap-2 justify-end items-center">
        {!clientReady && (
          <span className="text-[10px] text-zinc-600 mr-auto">
            Need a title, an outcome, {MIN_CRITERIA}+ criteria, and 1+ out-of-scope item.
          </span>
        )}
        <button
          onClick={() => {
            reset();
            setOpen(false);
          }}
          className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={submitting || !clientReady}
          className="px-4 py-2 text-sm bg-accent-bright/20 text-accent-bright rounded-lg hover:bg-accent-bright/30 transition-colors disabled:opacity-40"
        >
          {submitting ? "Submitting..." : "Submit request"}
        </button>
      </div>
    </div>
  );
}
