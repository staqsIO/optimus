"use client";

import type { FileContent } from "./types";

interface FilePreviewProps {
  file: FileContent;
  loading: boolean;
  isContext: boolean;
  onAddContext: (path: string) => void;
  onRemoveContext: (path: string) => void;
  onClose: () => void;
}

export default function FilePreview({
  file,
  loading,
  isContext,
  onAddContext,
  onRemoveContext,
  onClose,
}: FilePreviewProps) {
  if (loading) {
    return (
      <div className="p-5 bg-surface-raised rounded-lg border border-white/5">
        <div className="text-xs text-zinc-600">Loading file...</div>
      </div>
    );
  }

  const sizeLabel =
    file.size < 1024
      ? `${file.size} B`
      : `${Math.round(file.size / 1024)} KB`;

  return (
    <div className="bg-surface-raised rounded-lg border border-white/5 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-white/5">
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-xs font-mono text-zinc-300 truncate">
            {file.path}
          </span>
          <span className="text-[10px] text-zinc-600 shrink-0">{sizeLabel}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() =>
              isContext
                ? onRemoveContext(file.path)
                : onAddContext(file.path)
            }
            className={`px-2.5 py-1 text-xs rounded transition-colors ${
              isContext
                ? "bg-accent/15 text-accent-bright hover:bg-accent/25"
                : "bg-surface-overlay text-zinc-400 hover:text-zinc-200 border border-white/10"
            }`}
          >
            {isContext ? "Added as context" : "Use as context"}
          </button>
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-300 text-sm"
          >
            &times;
          </button>
        </div>
      </div>
      <pre className="p-4 text-xs text-zinc-400 overflow-auto max-h-[60vh]">
        <code>{file.content}</code>
      </pre>
    </div>
  );
}
