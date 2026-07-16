"use client";

import { useEffect, useState } from "react";

type Edit = {
  id: string;
  spec_id: string;
  section_id: string | null;
  actor: string;
  change_kind: string;
  before: string | null;
  after: string | null;
  note: string | null;
  created_at: string;
};

const KIND_COLORS: Record<string, string> = {
  edit: "text-blue-300",
  pin: "text-amber-300",
  unpin: "text-zinc-400",
  section_add: "text-emerald-300",
  section_remove: "text-red-300",
  section_reorder: "text-zinc-300",
  synth_skip_pin: "text-amber-200",
  section_proposal_new: "text-zinc-500",
  section_proposal_accept: "text-emerald-400",
  section_proposal_reject: "text-zinc-500",
};

export default function AuditDrawer({
  engagementId,
  sectionId,
  onClose,
}: {
  engagementId: string;
  sectionId?: string | null;
  onClose: () => void;
}) {
  const [edits, setEdits] = useState<Edit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const qs = new URLSearchParams();
    if (sectionId) qs.set("section_id", sectionId);
    qs.set("limit", "200");
    fetch(`/api/engagements/${engagementId}/audit?${qs.toString()}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
        return r.json();
      })
      .then((d) => setEdits(d.edits || []))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [engagementId, sectionId]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-end bg-black/70"
      onClick={onClose}
    >
      <div
        className="bg-zinc-900 border-l border-white/10 shadow-xl w-full max-w-xl h-full flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-white/10 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-100">
            Audit trail {sectionId ? "(for this section)" : "(whole engagement)"}
          </h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 text-sm">
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {loading && <div className="text-sm text-zinc-500">Loading…</div>}
          {error && <div className="text-sm text-red-400">{error}</div>}
          {!loading && edits.length === 0 && (
            <div className="text-sm text-zinc-500">No audit entries.</div>
          )}
          {edits.map((e) => (
            <div key={e.id} className="border border-white/5 rounded p-2 text-xs">
              <div className="flex items-center gap-2 mb-1">
                <span className={`text-[10px] uppercase tracking-wider font-semibold ${KIND_COLORS[e.change_kind] || "text-zinc-400"}`}>
                  {e.change_kind}
                </span>
                <span className="text-zinc-500 text-[10px]">·</span>
                <span className="text-zinc-400 text-[10px]">{e.actor}</span>
                <span className="text-zinc-500 text-[10px] ml-auto">
                  {new Date(e.created_at).toLocaleString()}
                </span>
              </div>
              {e.note && (
                <div className="text-[10px] text-zinc-500 italic mb-1">{e.note}</div>
              )}
              {(e.before || e.after) && (
                <details className="text-[10px] text-zinc-500">
                  <summary className="cursor-pointer hover:text-zinc-300">show diff</summary>
                  <div className="mt-1 grid grid-cols-2 gap-1">
                    <div>
                      <div className="text-zinc-600 mb-0.5">before</div>
                      <pre className="bg-red-950/20 border border-red-900/30 rounded p-1.5 whitespace-pre-wrap max-h-40 overflow-y-auto">
                        {e.before || "(empty)"}
                      </pre>
                    </div>
                    <div>
                      <div className="text-zinc-600 mb-0.5">after</div>
                      <pre className="bg-emerald-950/20 border border-emerald-900/30 rounded p-1.5 whitespace-pre-wrap max-h-40 overflow-y-auto">
                        {e.after || "(empty)"}
                      </pre>
                    </div>
                  </div>
                </details>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
