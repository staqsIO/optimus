"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Row = {
  id: string;
  spec_version: number;
  mode: "generic-template" | "tailored-client";
  format: "md" | "docx" | "gdoc";
  gdoc_url: string | null;
  cost_usd: number | string | null;
  generated_by: string;
  created_at: string;
  markdown_length: number;
  approved_at: string | null;
  approved_by: string | null;
};

const MODE_LABEL: Record<Row["mode"], string> = {
  "generic-template": "Generic template",
  "tailored-client": "Tailored",
};
const MODE_BADGE: Record<Row["mode"], string> = {
  "generic-template": "bg-amber-900/30 text-amber-300",
  "tailored-client": "bg-emerald-900/30 text-emerald-300",
};

export default function ProposalHistory({
  engagementId,
  refreshSignal = 0,
  onApprovalChange,
}: {
  engagementId: string;
  refreshSignal?: number;
  onApprovalChange?: (approved: Row | null) => void;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [approving, setApproving] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/engagements/${engagementId}/generated-proposals`);
      if (!res.ok) return;
      const data = await res.json();
      const list: Row[] = data.proposals || [];
      setRows(list);
      const approved = list.find((r) => r.mode === "tailored-client" && r.approved_at);
      if (onApprovalChange) onApprovalChange(approved || null);
    } finally {
      setLoading(false);
    }
  }, [engagementId, onApprovalChange]);

  useEffect(() => {
    load();
  }, [load, refreshSignal]);

  async function onApprove(row: Row) {
    const currentlyApproved = rows.find(
      (r) => r.mode === "tailored-client" && r.approved_at && r.id !== row.id
    );
    if (currentlyApproved) {
      const ok = confirm(
        `Another version is already approved (spec v${currentlyApproved.spec_version}, ` +
        `${new Date(currentlyApproved.created_at).toLocaleString()}). Approving this one ` +
        `will supersede it. Continue?`
      );
      if (!ok) return;
    }
    setApproving(row.id);
    try {
      const res = await fetch(
        `/api/engagements/${engagementId}/generated-proposals/${row.id}/approve`,
        { method: "POST" }
      );
      if (!res.ok) {
        const text = await res.text();
        alert(`Approve failed: ${res.status} ${text}`);
        return;
      }
      await load();
    } finally {
      setApproving(null);
    }
  }

  async function onUnapprove(row: Row) {
    if (!confirm(
      "Unapprove this proposal? You won't be able to draft a contract from it until you re-approve."
    )) return;
    setApproving(row.id);
    try {
      const res = await fetch(
        `/api/engagements/${engagementId}/generated-proposals/${row.id}/unapprove`,
        { method: "POST" }
      );
      if (!res.ok) {
        const text = await res.text();
        alert(`Unapprove failed: ${res.status} ${text}`);
        return;
      }
      await load();
    } finally {
      setApproving(null);
    }
  }

  async function onUpload(file: File) {
    if (!/\.docx$/i.test(file.name)) {
      alert("Only .docx files are supported.");
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      alert(`File too large (${(file.size / 1024 / 1024).toFixed(1)} MB, max 25 MB).`);
      return;
    }
    const currentlyApproved = rows.find(
      (r) => r.mode === "tailored-client" && r.approved_at
    );
    if (currentlyApproved) {
      const ok = confirm(
        `Uploading "${file.name}" will create a new tailored-client proposal ` +
        `and auto-approve it, superseding the currently-approved version ` +
        `(spec v${currentlyApproved.spec_version}, ` +
        `${new Date(currentlyApproved.created_at).toLocaleString()}). Continue?`
      );
      if (!ok) return;
    }
    setUploading(true);
    try {
      const buf = await file.arrayBuffer();
      // Base64-encode in chunks to avoid blowing the call stack on big files.
      const bytes = new Uint8Array(buf);
      let binary = "";
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      const content_base64 = btoa(binary);
      const res = await fetch(
        `/api/engagements/${engagementId}/generated-proposals/upload`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: file.name, content_base64 }),
        }
      );
      if (!res.ok) {
        const text = await res.text();
        alert(`Upload failed: ${res.status} ${text}`);
        return;
      }
      await load();
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function onDelete(id: string) {
    if (!confirm("Delete this generated proposal from history? The Google Doc (if any) is not affected.")) return;
    const res = await fetch(`/api/engagements/${engagementId}/generated-proposals/${id}`, { method: "DELETE" });
    if (!res.ok) {
      alert(`Delete failed: ${res.status}`);
      return;
    }
    setRows((prev) => prev.filter((r) => r.id !== id));
  }

  if (loading) return null;

  return (
    <div className="mt-3 pt-3 border-t border-white/5">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] uppercase tracking-wider text-zinc-500">
          Proposal history ({rows.length})
        </div>
        <div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onUpload(f);
            }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="text-[10px] text-zinc-300 hover:text-emerald-300 px-2 py-0.5 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 rounded"
            title="Upload a hand-edited .docx — it becomes a new tailored-client proposal and is auto-approved, replacing the currently approved version"
          >
            {uploading ? "Uploading…" : "Upload hand-edited .docx"}
          </button>
        </div>
      </div>
      {rows.length === 0 && (
        <div className="text-[10px] text-zinc-500 italic mb-2">
          No proposals generated or uploaded yet.
        </div>
      )}
      <div className="space-y-2">
        {rows.map((r) => {
          const isApproved = !!r.approved_at;
          const canApprove = r.mode === "tailored-client";
          return (
            <div
              key={r.id}
              className={`border rounded p-2 text-[10px] ${
                isApproved
                  ? "bg-emerald-950/30 border-emerald-500/40"
                  : "bg-zinc-900 border-white/5"
              }`}
            >
              <div className="flex items-center gap-1.5 mb-1 flex-wrap">
                <span className={`uppercase tracking-wider font-semibold px-1 py-0.5 rounded text-[9px] ${MODE_BADGE[r.mode]}`}>
                  {MODE_LABEL[r.mode]}
                </span>
                {isApproved && (
                  <span className="uppercase tracking-wider font-semibold px-1 py-0.5 rounded text-[9px] bg-emerald-600/40 text-emerald-200">
                    ✓ Approved
                  </span>
                )}
                <span className="text-zinc-600">·</span>
                <span className="text-zinc-500">spec v{r.spec_version}</span>
                <span className="text-zinc-600">·</span>
                <span className="text-zinc-500">{r.format}</span>
                {r.cost_usd != null && (
                  <>
                    <span className="text-zinc-600">·</span>
                    <span className="text-zinc-500">${Number(r.cost_usd).toFixed(4)}</span>
                  </>
                )}
              </div>
              <div className="text-zinc-500 mb-1.5">
                {new Date(r.created_at).toLocaleString()} · by {r.generated_by}
                {isApproved && r.approved_by && (
                  <span className="text-emerald-400/80"> · approved by {r.approved_by}</span>
                )}
              </div>
              <div className="flex gap-1.5 items-center flex-wrap">
                <a
                  href={`/api/engagements/${engagementId}/generated-proposals/${r.id}?format=md`}
                  className="text-zinc-300 hover:text-emerald-300 px-1.5 py-0.5 bg-zinc-800 hover:bg-zinc-700 rounded"
                >
                  .md
                </a>
                <a
                  href={`/api/engagements/${engagementId}/generated-proposals/${r.id}?format=docx`}
                  className="text-zinc-300 hover:text-emerald-300 px-1.5 py-0.5 bg-zinc-800 hover:bg-zinc-700 rounded"
                >
                  .docx
                </a>
                {r.gdoc_url && (
                  <a
                    href={r.gdoc_url}
                    target="_blank"
                    rel="noopener"
                    className="text-zinc-300 hover:text-emerald-300 px-1.5 py-0.5 bg-blue-900/30 hover:bg-blue-900/50 rounded"
                  >
                    Open Doc
                  </a>
                )}
                {canApprove && !isApproved && (
                  <button
                    onClick={() => onApprove(r)}
                    disabled={approving === r.id}
                    className="text-emerald-200 hover:text-emerald-100 px-1.5 py-0.5 bg-emerald-700/50 hover:bg-emerald-700 disabled:opacity-50 rounded"
                    title="Approve this version as the basis for a contract draft"
                  >
                    {approving === r.id ? "…" : "Approve"}
                  </button>
                )}
                {isApproved && (
                  <button
                    onClick={() => onUnapprove(r)}
                    disabled={approving === r.id}
                    className="text-zinc-400 hover:text-zinc-200 px-1.5 py-0.5 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 rounded"
                    title="Unapprove — drafting a contract from this version will be blocked"
                  >
                    {approving === r.id ? "…" : "Unapprove"}
                  </button>
                )}
                <button
                  onClick={() => onDelete(r.id)}
                  className="ml-auto text-zinc-600 hover:text-red-400"
                  title="Remove from history"
                >
                  ✕
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
