"use client";

/**
 * Renders the suggested signers as four collapsible sections. The parent
 * passes a flat array of EditableSigner rows; we group by `source` and
 * surface inline-editable name/email + a checkbox per row. Removing a row
 * filters it out of the parent's state — the parent also accepts custom
 * additions appended at the bottom of the array.
 */

export type RecipientSource = "primary" | "proposal" | "signal" | "internal";

export type EditableSigner = {
  name: string;
  email: string;
  source: RecipientSource;
  note: string | null;
  default_selected: boolean;
  github_username?: string;
  selected: boolean;
};

const SECTION_META: Record<RecipientSource, { label: string; hint: string; badge: string }> = {
  primary: {
    label: "Primary client signer",
    hint: "From the counterparty record. Signs first.",
    badge: "bg-emerald-500/20 text-emerald-300",
  },
  proposal: {
    label: "Mentioned in engagement documents",
    hint: "Email addresses we found in meetings, threads, or proposal attachments for this engagement.",
    badge: "bg-sky-500/20 text-sky-300",
  },
  signal: {
    label: "Other client contacts",
    hint: "Contacts at the client's domain you've corresponded with. Pick the ones who need to sign or be CC'd.",
    badge: "bg-blue-500/20 text-blue-300",
  },
  internal: {
    label: "UMB countersigners",
    hint: "Board members who countersign after the client signs.",
    badge: "bg-amber-500/20 text-amber-200",
  },
};

const SECTION_ORDER: RecipientSource[] = ["primary", "proposal", "signal", "internal"];

export default function RecipientPicker({
  rows,
  onChange,
}: {
  rows: EditableSigner[];
  onChange: (rows: EditableSigner[]) => void;
}) {
  const grouped: Record<RecipientSource, EditableSigner[]> = {
    primary: [],
    proposal: [],
    signal: [],
    internal: [],
  };
  for (const r of rows) grouped[r.source].push(r);

  function updateRow(email: string, patch: Partial<EditableSigner>) {
    onChange(rows.map((r) => (r.email === email ? { ...r, ...patch } : r)));
  }
  function removeRow(email: string) {
    onChange(rows.filter((r) => r.email !== email));
  }

  return (
    <div className="space-y-3">
      {SECTION_ORDER.map((source) => {
        const sectionRows = grouped[source];
        if (sectionRows.length === 0) return null;
        const meta = SECTION_META[source];
        return (
          <div key={source} className="rounded-lg border border-zinc-800 bg-zinc-950/40">
            <div className="px-3 py-2 border-b border-zinc-800 flex items-center gap-2">
              <span className={`px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider rounded ${meta.badge}`}>
                {source}
              </span>
              <span className="text-[11px] font-medium text-zinc-200">{meta.label}</span>
              <span className="text-[10px] text-zinc-500 ml-auto">{sectionRows.length}</span>
            </div>
            <p className="px-3 pt-2 text-[10px] text-zinc-500 leading-snug">{meta.hint}</p>
            <div className="p-3 space-y-1.5">
              {sectionRows.map((r) => (
                <div key={r.email} className="flex gap-2 items-center">
                  <input
                    type="checkbox"
                    checked={r.selected}
                    onChange={(e) => updateRow(r.email, { selected: e.target.checked })}
                    className="rounded border-zinc-600 bg-zinc-800 text-amber-500 focus:ring-amber-500/50 shrink-0"
                  />
                  <input
                    value={r.name}
                    onChange={(e) => updateRow(r.email, { name: e.target.value })}
                    placeholder="name"
                    className="w-32 px-2 py-1 text-[12px] bg-zinc-900 border border-zinc-700 rounded text-zinc-100 focus:outline-none focus:border-amber-500/50"
                  />
                  <input
                    value={r.email}
                    onChange={(e) => {
                      // Editing the email is the row's identity — update by
                      // sliding the new value into the same position rather
                      // than replacing keyed-by-email (which would lose state).
                      const next = rows.map((x) =>
                        x.email === r.email ? { ...x, email: e.target.value } : x
                      );
                      onChange(next);
                    }}
                    placeholder="email@example.com"
                    type="email"
                    className="flex-1 px-2 py-1 text-[12px] bg-zinc-900 border border-zinc-700 rounded text-zinc-100 focus:outline-none focus:border-amber-500/50"
                  />
                  {r.note && (
                    <span className="text-[10px] text-zinc-500 hidden md:inline">{r.note}</span>
                  )}
                  <button
                    onClick={() => removeRow(r.email)}
                    title="Remove from this send"
                    className="text-zinc-600 hover:text-red-400 text-sm px-1"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
