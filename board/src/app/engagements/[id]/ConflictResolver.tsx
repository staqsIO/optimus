"use client";

import { useState } from "react";
import type { Conflict } from "./EngagementClient";

export default function ConflictResolver({
  conflict,
  onResolve,
  onDismiss,
  onClose,
}: {
  conflict: Conflict;
  onResolve: (optionIndex: number) => Promise<void>;
  onDismiss: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function pick(idx: number) {
    setBusy(true);
    try {
      await onResolve(idx);
    } catch (err) {
      alert(`Resolve failed: ${(err as Error).message}`);
      setBusy(false);
    }
  }

  async function dismiss() {
    setBusy(true);
    try {
      await onDismiss();
    } catch (err) {
      alert(`Dismiss failed: ${(err as Error).message}`);
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      onClick={onClose}
    >
      <div
        className="bg-zinc-900 border border-white/10 rounded-lg shadow-xl w-full max-w-2xl mx-4 max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-white/10">
          <div className="text-xs uppercase tracking-wider text-zinc-500">Resolve conflict</div>
          <h3 className="text-base font-semibold text-zinc-100 mt-1">{conflict.summary}</h3>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {conflict.options.map((opt, idx) => (
            <button
              key={idx}
              onClick={() => pick(idx)}
              disabled={busy}
              className="block w-full text-left p-3 border border-white/10 rounded hover:border-emerald-500 hover:bg-emerald-950/20 disabled:opacity-50 transition-colors"
            >
              <div className="text-xs uppercase tracking-wider text-zinc-500 mb-1">
                Option {idx + 1}
              </div>
              <div className="text-sm text-zinc-200 whitespace-pre-wrap">{opt.text}</div>
              {opt.rationale && (
                <div className="text-xs text-zinc-500 mt-2 italic">{opt.rationale}</div>
              )}
            </button>
          ))}
        </div>
        <div className="px-5 py-3 border-t border-white/10 flex justify-between gap-2">
          <button
            onClick={dismiss}
            disabled={busy}
            className="px-3 py-1.5 text-xs text-zinc-400 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 rounded"
          >
            Dismiss (don't apply)
          </button>
          <button
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1.5 text-xs text-zinc-400 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 rounded"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
