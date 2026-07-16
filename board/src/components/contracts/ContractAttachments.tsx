"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { opsFetch, opsPost, opsDelete } from "@/lib/ops-api";

interface Attachment {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  uploaded_by: string | null;
  created_at: string;
}

interface ContractAttachmentsProps {
  contractId: string;
  readOnly?: boolean;
}

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fileIcon(mimeType: string, filename: string): string {
  if (mimeType.startsWith("image/")) return "🖼️";
  if (mimeType === "application/pdf" || filename.endsWith(".pdf")) return "📄";
  if (mimeType.includes("spreadsheet") || /\.(xlsx?|csv)$/i.test(filename)) return "📊";
  if (mimeType.includes("word") || /\.docx?$/i.test(filename)) return "📝";
  if (mimeType.includes("zip") || /\.(zip|tar|gz)$/i.test(filename)) return "🗜️";
  return "📎";
}

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip the "data:mime;base64," prefix
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export default function ContractAttachments({ contractId, readOnly = false }: ContractAttachmentsProps) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const data = await opsFetch<{ attachments: Attachment[] }>(
      `/api/contracts/${contractId}/attachments`
    );
    setAttachments(data?.attachments || []);
    setLoading(false);
  }, [contractId]);

  useEffect(() => { load(); }, [load]);

  async function uploadFiles(files: File[]) {
    if (files.length === 0) return;
    setError(null);
    setUploading(true);
    try {
      for (const file of files) {
        if (file.size > MAX_BYTES) {
          setError(`${file.name} is too large (${formatSize(file.size)}, max 25 MB)`);
          continue;
        }
        const base64 = await fileToBase64(file);
        const result = await opsPost<{ ok: boolean; attachment: Attachment }>(
          `/api/contracts/${contractId}/attachments`,
          {
            filename: file.name,
            mime_type: file.type || "application/octet-stream",
            content_base64: base64,
          }
        );
        if (!result.ok) {
          setError(`${file.name}: ${result.error || "upload failed"}`);
        }
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "upload failed");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) uploadFiles(files);
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    if (readOnly) return;
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length > 0) uploadFiles(files);
  }

  async function handleDelete(id: string, name: string) {
    if (!window.confirm(`Remove "${name}"?`)) return;
    const result = await opsDelete(`/api/contracts/${contractId}/attachments/${id}`);
    if (result.ok) {
      setAttachments((prev) => prev.filter((a) => a.id !== id));
    } else {
      setError(result.error || "delete failed");
    }
  }

  function handleDownload(att: Attachment) {
    // Use the signed proxy path — our /api/ops GET supports binary passthrough
    const proxyUrl = `/api/ops?path=${encodeURIComponent(
      `/api/contracts/${contractId}/attachments/${att.id}/download`
    )}`;
    // Open in new tab; browser triggers save via Content-Disposition header
    window.open(proxyUrl, "_blank", "noopener,noreferrer");
  }

  if (loading) return null;

  const hasAny = attachments.length > 0;

  return (
    <div className="border-t border-zinc-800 bg-zinc-950/40">
      <div className="px-3 py-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider">
            Attachments
          </span>
          <span className="text-[10px] text-zinc-600">
            {hasAny ? `${attachments.length} file${attachments.length === 1 ? "" : "s"}` : "none"}
          </span>
        </div>
        {!readOnly && (
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="px-2.5 py-1 text-[10px] font-medium rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700 disabled:opacity-50 transition-colors"
          >
            {uploading ? "Uploading…" : "+ Upload"}
          </button>
        )}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={onFileChange}
        />
      </div>

      {/* Drop zone (only when empty or dragging) */}
      {!readOnly && !hasAny && (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`mx-3 mb-2 px-3 py-4 border border-dashed rounded cursor-pointer transition-colors text-center ${
            dragOver
              ? "border-amber-500/60 bg-amber-500/5 text-amber-300"
              : "border-zinc-700 hover:border-zinc-600 text-zinc-600 hover:text-zinc-400"
          }`}
        >
          <div className="text-[11px]">
            Drop files here or click to upload
          </div>
          <div className="text-[9px] text-zinc-600 mt-0.5">
            PDF, images, docs · up to 25 MB each
          </div>
        </div>
      )}

      {/* File list */}
      {hasAny && (
        <div
          onDragOver={(e) => !readOnly && (e.preventDefault(), setDragOver(true))}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          className={`px-3 pb-2 space-y-1 ${dragOver ? "bg-amber-500/5" : ""}`}
        >
          {attachments.map((att) => (
            <div
              key={att.id}
              className="flex items-center gap-2 px-2 py-1.5 rounded bg-zinc-900 hover:bg-zinc-800/80 transition-colors border border-zinc-800 group"
            >
              <span className="text-sm shrink-0">{fileIcon(att.mime_type, att.filename)}</span>
              <button
                onClick={() => handleDownload(att)}
                className="flex-1 text-left text-[11px] text-zinc-300 truncate hover:text-amber-300 hover:underline underline-offset-2"
                title={`Download ${att.filename}`}
              >
                {att.filename}
              </button>
              <span className="text-[10px] text-zinc-600 shrink-0">{formatSize(att.size_bytes)}</span>
              {!readOnly && (
                <button
                  onClick={() => handleDelete(att.id, att.filename)}
                  className="text-zinc-700 hover:text-red-400 transition-colors text-xs px-1 opacity-0 group-hover:opacity-100"
                  title="Remove"
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="px-3 pb-2 text-[10px] text-red-400">{error}</div>
      )}
    </div>
  );
}
