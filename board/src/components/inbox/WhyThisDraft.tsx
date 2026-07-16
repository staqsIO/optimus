"use client";

import { useState } from "react";
import { type Draft, ALL_GATES, GATE_LABELS } from "./QueueItem";
import { gateWhy } from "@/lib/draft-explanations";

export default function WhyThisDraft({ draft }: { draft: Draft }) {
  const [open, setOpen] = useState(true);
  const gates = draft.gate_results ?? {};
  const failed = ALL_GATES.filter((g) => gates[g] && gates[g].passed === false);

  return (
    <div className="border-b border-white/5 bg-surface-overlay/20">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full px-4 py-2.5 flex items-center justify-between text-left hover:bg-white/[0.03] transition-colors"
      >
        <span className="text-xs font-medium text-zinc-300">Why this draft?</span>
        <span className="text-[10px] text-zinc-500">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <div className="px-4 pb-3 space-y-3 text-sm text-zinc-400">
          <p className="text-xs text-zinc-500 leading-relaxed">
            Quick read on what the pipeline concluded before you approve. Constitutional gates are enforced in the database, not only in the model.
          </p>
          {(draft.email_summary || draft.draft_intent) && (
            <div className="space-y-1.5 text-xs">
              {draft.email_summary && (
                <div>
                  <span className="text-zinc-500">They want: </span>
                  <span className="text-zinc-300">{draft.email_summary}</span>
                </div>
              )}
              {draft.draft_intent && (
                <div>
                  <span className="text-zinc-500">Draft does: </span>
                  <span className="text-zinc-300">{draft.draft_intent}</span>
                </div>
              )}
            </div>
          )}
          {failed.length > 0 && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
              <span className="font-medium">Needs attention: </span>
              {failed.map((g) => (
                <span key={g} className="mr-2">
                  {g} ({GATE_LABELS[g]})
                </span>
              ))}
            </div>
          )}
          <ul className="space-y-2">
            {ALL_GATES.map((g) => {
              const r = gates[g];
              const passed = r?.passed !== false;
              const has = !!r;
              return (
                <li key={g} className="flex gap-2 text-xs">
                  <span
                    className={`shrink-0 mt-0.5 h-1.5 w-1.5 rounded-full ${
                      !has ? "bg-zinc-600" : passed ? "bg-emerald-500" : "bg-red-500"
                    }`}
                  />
                  <div>
                    <span className="text-zinc-300 font-medium">{g}</span>
                    <span className="text-zinc-500"> — {GATE_LABELS[g]}: </span>
                    <span className="text-zinc-400">
                      {has && !passed ? r?.detail || "This check did not pass — review before sending." : gateWhy(g)}
                    </span>
                    {has && passed && r?.detail && (
                      <span className="block text-zinc-500 mt-0.5 italic">{r.detail}</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
