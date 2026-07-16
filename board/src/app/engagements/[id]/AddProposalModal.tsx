"use client";

import { useRef, useState } from "react";
import { OrgSelector } from "@/components/OrgSelector";

type Tab = "paste" | "upload" | "url";

const PROPOSAL_KINDS = [
  { value: "draft", label: "Draft" },
  { value: "finalized", label: "Finalized" },
  { value: "note", label: "Note" },
];

export default function AddProposalModal({
  engagementId,
  onClose,
  onIngested,
}: {
  engagementId: string;
  onClose: () => void;
  onIngested: () => void;
}) {
  const [tab, setTab] = useState<Tab>("paste");
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState("draft");
  const [onBehalfOfOrgId, setOnBehalfOfOrgId] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [url, setUrl] = useState("");
  const [filename, setFilename] = useState<string | null>(null);
  const [fileB64, setFileB64] = useState<string | null>(null);
  const [fileSize, setFileSize] = useState<number>(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function bytesToBase64(bytes: Uint8Array): string {
    // Chunked encode to avoid call-stack issues on very large files.
    const CHUNK = 0x8000;
    let binary = "";
    for (let i = 0; i < bytes.length; i += CHUNK) {
      const sub = bytes.subarray(i, i + CHUNK);
      binary += String.fromCharCode(...sub);
    }
    return btoa(binary);
  }

  async function readFile(file: File) {
    const ext = file.name.toLowerCase().split(".").pop() || "";
    if (!["md", "markdown", "txt", "pdf", "docx"].includes(ext)) {
      setError(
        `Unsupported file type .${ext}. Accepted: .md, .txt, .pdf, .docx — or use the Paste tab.`
      );
      return;
    }
    setError(null);
    const buf = await file.arrayBuffer();
    const b64 = bytesToBase64(new Uint8Array(buf));
    setFilename(file.name);
    setFileB64(b64);
    setFileSize(buf.byteLength);
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      let body: Record<string, unknown> = {
        kind,
        title: title.trim() || undefined,
        ...(onBehalfOfOrgId ? { on_behalf_of_org_id: onBehalfOfOrgId } : {}),
      };
      if (tab === "paste") {
        if (!content.trim()) throw new Error("Paste some content");
        body.source_type = "paste";
        body.content = content;
      } else if (tab === "upload") {
        if (!filename || !fileB64) throw new Error("Pick a file (.md, .txt, .pdf, .docx)");
        body.source_type = "upload";
        body.filename = filename;
        body.content_b64 = fileB64;
      } else {
        if (!url.trim()) throw new Error("Paste a URL");
        if (!/^https?:\/\//i.test(url)) throw new Error("URL must start with http(s)://");
        body.source_type = "url";
        body.url = url.trim();
      }

      const res = await fetch(`/api/engagements/${engagementId}/proposals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `${res.status}`);
      }
      onIngested();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      onClick={onClose}
    >
      <div
        className="bg-zinc-900 border border-white/10 rounded-lg shadow-xl w-full max-w-2xl mx-4 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-white/10">
          <h3 className="text-base font-semibold text-zinc-100">Add proposal</h3>
        </div>

        <div className="flex border-b border-white/10">
          {(["paste", "upload", "url"] as const).map((t) => (
            <button
              key={t}
              onClick={() => {
                setTab(t);
                setError(null);
              }}
              className={`px-4 py-2 text-xs uppercase tracking-wider transition-colors ${
                tab === t
                  ? "text-emerald-300 border-b-2 border-emerald-500 -mb-px"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="p-5 space-y-4 max-h-[60vh] overflow-y-auto">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs uppercase tracking-wider text-zinc-500 mb-1.5">
                Title (optional)
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Auto-derived from content"
                className="w-full px-3 py-2 text-sm bg-zinc-800 border border-white/10 rounded text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500"
              />
            </div>
            <div>
              <label className="block text-xs uppercase tracking-wider text-zinc-500 mb-1.5">
                Kind
              </label>
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-zinc-800 border border-white/10 rounded text-zinc-200 focus:outline-none focus:border-emerald-500"
              >
                {PROPOSAL_KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <OrgSelector
            value={onBehalfOfOrgId}
            onChange={setOnBehalfOfOrgId}
            disabled={busy}
          />

          {tab === "paste" && (
            <div>
              <label className="block text-xs uppercase tracking-wider text-zinc-500 mb-1.5">
                Content
              </label>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={12}
                placeholder="Paste the proposal text or markdown…"
                className="w-full px-3 py-2 text-sm bg-zinc-950 border border-white/10 rounded text-zinc-200 placeholder:text-zinc-600 font-mono focus:outline-none focus:border-emerald-500 resize-y"
              />
            </div>
          )}

          {tab === "upload" && (
            <div>
              <label className="block text-xs uppercase tracking-wider text-zinc-500 mb-1.5">
                File (.md, .txt, .pdf, .docx)
              </label>
              <input
                ref={fileInputRef}
                type="file"
                accept=".md,.markdown,.txt,.pdf,.docx"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) readFile(file);
                }}
                className="block w-full text-sm text-zinc-400 file:mr-3 file:px-3 file:py-1.5 file:text-xs file:bg-zinc-800 file:text-zinc-200 file:border-0 file:rounded hover:file:bg-zinc-700"
              />
              {filename && (
                <div className="text-xs text-zinc-400 mt-2">
                  Loaded: <span className="text-zinc-200">{filename}</span> (
                  {(fileSize / 1024).toFixed(1)} KB)
                </div>
              )}
              <p className="text-[10px] text-zinc-600 mt-2">
                Text is extracted server-side. Scanned/image PDFs won't extract — paste the content instead.
              </p>
            </div>
          )}

          {tab === "url" && (
            <div>
              <label className="block text-xs uppercase tracking-wider text-zinc-500 mb-1.5">
                URL
              </label>
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://…"
                className="w-full px-3 py-2 text-sm bg-zinc-800 border border-white/10 rounded text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500"
              />
              <p className="text-[10px] text-zinc-600 mt-2">
                Public pages only. Auth-walled docs (Google Docs, Notion private) won't fetch —
                use Paste instead.
              </p>
            </div>
          )}

          {error && <div className="text-sm text-red-400">{error}</div>}
        </div>

        <div className="px-5 py-3 border-t border-white/10 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1.5 text-xs text-zinc-400 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 rounded"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy}
            className="px-3 py-1.5 text-xs bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white rounded"
          >
            {busy ? "Ingesting…" : "Add proposal"}
          </button>
        </div>
      </div>
    </div>
  );
}
