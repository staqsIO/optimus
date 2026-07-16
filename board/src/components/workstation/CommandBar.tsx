"use client";

import { useRef, useEffect, useCallback, useState } from "react";
import type { CommandChip, TreeNode, UploadedFile } from "./types";
import FileBrowser from "./FileBrowser";

const UPLOAD_ACCEPT = ".png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.md,.json,.csv,.xml,.sql,.ts,.tsx,.js";

const SIZE_LIMITS: Record<string, number> = {
  "image/png": 5 * 1024 * 1024,
  "image/jpeg": 5 * 1024 * 1024,
  "image/gif": 5 * 1024 * 1024,
  "image/webp": 5 * 1024 * 1024,
  "application/pdf": 25 * 1024 * 1024,
};
const DEFAULT_SIZE_LIMIT = 1 * 1024 * 1024; // 1MB for text files

function getSizeLimit(mimeType: string): number {
  return SIZE_LIMITS[mimeType] ?? DEFAULT_SIZE_LIMIT;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

interface CommandBarProps {
  input: string;
  onInputChange: (value: string) => void;
  contextFiles: string[];
  onRemoveContextFile: (path: string) => void;
  uploadedFiles: UploadedFile[];
  onUploadFile: (file: UploadedFile) => void;
  onRemoveUploadedFile: (id: string) => void;
  activeChip: CommandChip | null;
  onChipChange: (chip: CommandChip | null) => void;
  onSubmit: () => void;
  onAgendaClick: () => void;
  loading?: boolean;
  classifiedIntent?: CommandChip | null;
  fileBrowserOpen: boolean;
  onOpenFileBrowser: () => void;
  onCloseFileBrowser: () => void;
  onFileSelect: (path: string) => void;
  tree: TreeNode[];
  treeLoading: boolean;
  error?: string | null;
}

const CHIP_STYLES: Record<CommandChip, string> = {
  change: "bg-purple-500/20 text-purple-300 border-purple-500/30",
  ask: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  research: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
  agenda: "bg-amber-500/20 text-amber-300 border-amber-500/30",
  intake: "bg-teal-500/20 text-teal-300 border-teal-500/30",
  build: "bg-orange-500/20 text-orange-300 border-orange-500/30",
  content: "bg-violet-500/20 text-violet-300 border-violet-500/30",
  contract: "bg-pink-500/20 text-pink-300 border-pink-500/30",
};

const CHIP_LABELS: Record<CommandChip, string> = {
  change: "Change",
  ask: "Ask",
  research: "Analyze URL",
  agenda: "SPEC.md",
  intake: "Intake",
  build: "Build",
  content: "Content",
  contract: "Contract",
};

const CHIP_INACTIVE = "bg-white/[0.03] text-zinc-500 border-white/5 hover:bg-white/[0.06] hover:text-zinc-400";

export default function CommandBar({
  input,
  onInputChange,
  contextFiles,
  onRemoveContextFile,
  uploadedFiles,
  onUploadFile,
  onRemoveUploadedFile,
  activeChip,
  onChipChange,
  onSubmit,
  onAgendaClick,
  loading,
  classifiedIntent,
  fileBrowserOpen,
  onOpenFileBrowser,
  onCloseFileBrowser,
  onFileSelect,
  tree,
  treeLoading,
  error,
}: CommandBarProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const attachMenuRef = useRef<HTMLDivElement>(null);

  // Close attach menu on outside click
  useEffect(() => {
    if (!attachMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (attachMenuRef.current && !attachMenuRef.current.contains(e.target as Node)) {
        setAttachMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [attachMenuOpen]);

  const handleFileUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files) return;
      setUploadError(null);

      Array.from(files).forEach((file) => {
        const limit = getSizeLimit(file.type);
        if (file.size > limit) {
          setUploadError(`${file.name} exceeds ${formatFileSize(limit)} limit`);
          return;
        }

        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          const base64 = dataUrl.split(",")[1];
          onUploadFile({
            id: `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: file.name,
            mimeType: file.type || "text/plain",
            base64,
            size: file.size,
          });
        };
        reader.readAsDataURL(file);
      });

      // Reset so the same file can be re-selected
      e.target.value = "";
    },
    [onUploadFile]
  );

  // Auto-expand textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`;
    }
  }, [input]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (activeChip === "agenda") {
          onAgendaClick();
        } else {
          onSubmit();
        }
      }
    },
    [onSubmit, onAgendaClick, activeChip]
  );

  const handleChipClick = useCallback(
    (chip: CommandChip) => {
      if (chip === "agenda") {
        onAgendaClick();
        return;
      }
      // Toggle: clicking active chip deselects back to auto mode
      onChipChange(activeChip === chip ? null : chip);
    },
    [onChipChange, onAgendaClick, activeChip]
  );

  const chips: CommandChip[] = ["change", "ask", "build", "research", "agenda", "intake"];

  return (
    <>
      <div className="sticky top-0 z-30 bg-zinc-900/80 backdrop-blur-md border-b border-white/10">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-3 space-y-2">
          {/* Context file pills + Upload pills */}
          {(contextFiles.length > 0 || uploadedFiles.length > 0 || uploadError) && (
            <div className="flex flex-wrap gap-1.5">
              {contextFiles.map((path) => (
                <span
                  key={path}
                  className="inline-flex items-center gap-1.5 px-2 py-0.5 text-xs bg-accent/10 text-accent-bright rounded-full border border-accent/20"
                >
                  <span className="max-w-[180px] truncate">{path}</span>
                  <button
                    onClick={() => onRemoveContextFile(path)}
                    className="text-accent-bright/60 hover:text-accent-bright transition-colors"
                    aria-label={`Remove ${path}`}
                  >
                    &times;
                  </button>
                </span>
              ))}
              {uploadedFiles.map((file) => (
                <span
                  key={file.id}
                  className="inline-flex items-center gap-1.5 px-2 py-0.5 text-xs bg-teal-500/10 text-teal-300 rounded-full border border-teal-500/20"
                >
                  <span className="max-w-[180px] truncate">{file.name}</span>
                  <span className="text-teal-400/50">{formatFileSize(file.size)}</span>
                  <button
                    onClick={() => onRemoveUploadedFile(file.id)}
                    className="text-teal-300/60 hover:text-teal-300 transition-colors"
                    aria-label={`Remove ${file.name}`}
                  >
                    &times;
                  </button>
                </span>
              ))}
              {uploadError && (
                <span className="text-xs text-red-400">{uploadError}</span>
              )}
            </div>
          )}

          {/* Textarea + controls */}
          <div className="flex items-end gap-2">
            {/* Paperclip dropdown */}
            <div className="relative flex-shrink-0" ref={attachMenuRef}>
              <button
                onClick={() => setAttachMenuOpen((v) => !v)}
                className="p-2 text-zinc-500 hover:text-zinc-300 transition-colors rounded-lg hover:bg-white/[0.04]"
                title="Attach files"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
                </svg>
              </button>
              {attachMenuOpen && (
                <div className="absolute bottom-full left-0 mb-1 w-44 bg-zinc-800 border border-white/10 rounded-lg shadow-xl overflow-hidden z-50">
                  <button
                    onClick={() => {
                      setAttachMenuOpen(false);
                      onOpenFileBrowser();
                    }}
                    className="w-full px-3 py-2 text-left text-sm text-zinc-300 hover:bg-white/[0.06] flex items-center gap-2"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                    </svg>
                    Browse Repo
                  </button>
                  <button
                    onClick={() => {
                      setAttachMenuOpen(false);
                      setUploadError(null);
                      fileInputRef.current?.click();
                    }}
                    className="w-full px-3 py-2 text-left text-sm text-zinc-300 hover:bg-white/[0.06] flex items-center gap-2"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                      <polyline points="17 8 12 3 7 8" />
                      <line x1="12" y1="3" x2="12" y2="15" />
                    </svg>
                    Upload File
                  </button>
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={UPLOAD_ACCEPT}
                onChange={handleFileUpload}
                className="hidden"
              />
            </div>

            {/* Textarea */}
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => onInputChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={activeChip ? `${CHIP_LABELS[activeChip]} mode — type your input...` : "What do you need?"}
              rows={1}
              className="flex-1 px-3 py-2 text-sm bg-white/[0.03] border border-white/10 rounded-lg text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-accent/50 resize-none overflow-hidden"
            />

            {/* Send button */}
            <button
              onClick={activeChip === "agenda" ? onAgendaClick : onSubmit}
              disabled={activeChip !== "agenda" && (!input.trim() || loading)}
              className="flex-shrink-0 px-4 py-2 text-sm bg-accent hover:bg-accent-dim text-white rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {loading ? "..." : activeChip === "agenda" ? "Open" : "Send"}
            </button>
          </div>

          {/* Inline error message */}
          {error && (
            <div className="px-1 text-xs text-red-400 leading-snug">
              {error}
            </div>
          )}

          {/* Mode chips + classified intent indicator */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {chips.map((chip) => (
              <button
                key={chip}
                onClick={() => handleChipClick(chip)}
                className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                  activeChip === chip ? CHIP_STYLES[chip] : CHIP_INACTIVE
                }`}
              >
                {CHIP_LABELS[chip]}
              </button>
            ))}
            {!activeChip && (
              <span className="ml-1 px-2 py-0.5 text-[10px] text-zinc-600 border border-white/5 rounded-full">
                auto
              </span>
            )}
            {classifiedIntent && !activeChip && (
              <span className="ml-0.5 text-[10px] text-zinc-500 animate-pulse">
                Routing as {CHIP_LABELS[classifiedIntent]}...
              </span>
            )}
          </div>
        </div>
      </div>

      {/* File browser modal */}
      {fileBrowserOpen && (
        <>
          <div
            className="fixed inset-0 bg-black/60 z-40"
            onClick={onCloseFileBrowser}
          />
          <div className="fixed inset-0 md:inset-y-0 md:left-0 md:right-auto z-50 md:w-80 md:max-w-[90vw] bg-zinc-900 md:border-r border-white/10 shadow-2xl">
            <FileBrowser
              tree={tree}
              loading={treeLoading}
              onFileSelect={(path) => {
                onFileSelect(path);
                onCloseFileBrowser();
              }}
              onClose={onCloseFileBrowser}
            />
          </div>
        </>
      )}
    </>
  );
}
