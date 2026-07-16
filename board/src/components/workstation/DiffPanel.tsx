"use client";

import { useState, useMemo } from "react";
import type { GenerationResult, FileChange } from "./types";
import DiffViewer from "./DiffViewer";
import { createFileAsAdditions, computeDiffStats } from "@/lib/diff";

interface DiffPanelProps {
  result: GenerationResult;
  commitMessage: string;
  iteratePrompt: string;
  showReasoning: boolean;
  onCommitMessageChange: (msg: string) => void;
  onIteratePromptChange: (prompt: string) => void;
  onToggleReasoning: () => void;
  onIterate: () => void;
  onCreatePR: () => void;
  onDiscard: () => void;
}

function FileIcon({ action }: { action: FileChange["action"] }) {
  if (action === "create") {
    return (
      <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-green-500/15 text-green-400 text-[9px] font-bold flex-shrink-0">
        +
      </span>
    );
  }
  return (
    <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-amber-500/15 text-amber-400 text-[9px] font-bold flex-shrink-0">
      ~
    </span>
  );
}

function pathParts(path: string): { dir: string; name: string } {
  const lastSlash = path.lastIndexOf("/");
  if (lastSlash === -1) return { dir: "", name: path };
  return { dir: path.slice(0, lastSlash + 1), name: path.slice(lastSlash + 1) };
}

export default function DiffPanel({
  result,
  commitMessage,
  iteratePrompt,
  showReasoning,
  onCommitMessageChange,
  onIteratePromptChange,
  onToggleReasoning,
  onIterate,
  onCreatePR,
  onDiscard,
}: DiffPanelProps) {
  const [expandedFile, setExpandedFile] = useState<string | null>(
    result.files.length === 1 ? result.files[0].path : null
  );

  // Compute aggregate stats
  const stats = useMemo(() => {
    let totalAdded = 0;
    let totalRemoved = 0;
    let creates = 0;
    let modifies = 0;

    for (const file of result.files) {
      if (file.action === "create") {
        creates++;
        totalAdded += file.content.split("\n").length;
      } else {
        modifies++;
        // Without original content, we count all lines as context
        // When originalContent is available, we'd use computeLineDiff here
        totalAdded += file.content.split("\n").length;
      }
    }

    return { totalAdded, totalRemoved, creates, modifies };
  }, [result.files]);

  return (
    <div className="space-y-4">
      {/* Executive summary */}
      <div className="p-4 bg-surface-raised rounded-lg border border-white/5 space-y-3">
        {/* Reasoning as visible 1-liner */}
        {result.reasoning && (
          <p className="text-sm text-zinc-300 leading-relaxed line-clamp-2">
            {result.reasoning.split("\n")[0]}
          </p>
        )}

        {/* Stats bar */}
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className="text-zinc-400">
            {result.files.length} file{result.files.length !== 1 ? "s" : ""}
          </span>
          {stats.creates > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-green-500/10 text-green-400 border border-green-500/20">
              {stats.creates} new
            </span>
          )}
          {stats.modifies > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20">
              {stats.modifies} modified
            </span>
          )}
          <span className="text-green-400">+{stats.totalAdded}</span>
          {stats.totalRemoved > 0 && (
            <span className="text-red-400">-{stats.totalRemoved}</span>
          )}
        </div>

        {/* Full reasoning (collapsible) */}
        <button
          onClick={onToggleReasoning}
          className="flex items-center gap-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          <span className="text-[10px]">{showReasoning ? "\u25BC" : "\u25B6"}</span>
          Full reasoning
        </button>
        {showReasoning && (
          <div className="px-4 py-3 text-sm text-zinc-400 bg-surface rounded-lg border border-white/5 whitespace-pre-wrap max-h-64 overflow-y-auto">
            {result.reasoning}
          </div>
        )}
      </div>

      {/* File tree with inline diffs */}
      <div className="bg-surface-raised rounded-lg border border-white/5 overflow-hidden">
        {result.files.map((file) => {
          const isExpanded = expandedFile === file.path;
          const { dir, name } = pathParts(file.path);
          const lineCount = file.content.split("\n").length;

          // For create files, show all lines as additions
          const diffLines = file.action === "create"
            ? createFileAsAdditions(file.content)
            : null; // No diff for modified files without original content

          const fileStats = diffLines ? computeDiffStats(diffLines) : null;

          return (
            <div key={file.path} className={isExpanded ? "" : "border-b border-white/5 last:border-b-0"}>
              {/* File header */}
              <button
                onClick={() => setExpandedFile(isExpanded ? null : file.path)}
                className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-white/[0.02] transition-colors"
              >
                <FileIcon action={file.action} />
                <span className="text-xs font-mono text-zinc-500">{dir}</span>
                <span className="text-xs font-mono text-zinc-200">{name}</span>
                <span className="ml-auto flex items-center gap-2">
                  {fileStats ? (
                    <span className="text-[10px] text-green-400">+{fileStats.added}</span>
                  ) : (
                    <span className="text-[10px] text-zinc-600">{lineCount} lines</span>
                  )}
                  <svg
                    className={`w-3.5 h-3.5 text-zinc-600 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                    fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                  </svg>
                </span>
              </button>

              {/* File content */}
              {isExpanded && (
                <div className="border-t border-white/5">
                  {diffLines ? (
                    <DiffViewer lines={diffLines} maxHeight="max-h-[32rem]" />
                  ) : (
                    /* Modified file without original — show content with line numbers */
                    <div className="max-h-[32rem] overflow-y-auto overflow-x-auto">
                      {file.content.split("\n").map((line, i) => (
                        <div key={i} className="flex text-xs font-mono leading-5">
                          <span className="w-10 flex-shrink-0 text-right pr-2 text-zinc-700 select-none border-r border-white/5">
                            {i + 1}
                          </span>
                          <span className="px-3 whitespace-pre-wrap break-all text-zinc-400">
                            {line}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Commit message */}
      <div className="p-5 bg-surface-raised rounded-lg border border-white/5 space-y-3">
        <label className="block text-xs text-zinc-500">Commit message</label>
        <input
          type="text"
          value={commitMessage}
          onChange={(e) => onCommitMessageChange(e.target.value)}
          className="w-full px-3 py-2 text-sm bg-surface border border-white/10 rounded-lg text-zinc-200 focus:outline-none focus:border-accent/50"
        />
      </div>

      {/* Iterate */}
      <div className="p-5 bg-surface-raised rounded-lg border border-white/5 space-y-3">
        <label className="block text-xs text-zinc-500">
          Want changes? Describe what to adjust
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            value={iteratePrompt}
            onChange={(e) => onIteratePromptChange(e.target.value)}
            placeholder="e.g. also update the table of contents..."
            className="flex-1 px-3 py-2 text-sm bg-surface border border-white/10 rounded-lg text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-accent/50"
            onKeyDown={(e) => {
              if (e.key === "Enter" && iteratePrompt.trim()) onIterate();
            }}
          />
          <button
            onClick={onIterate}
            disabled={!iteratePrompt.trim()}
            className="px-4 py-2 text-sm bg-surface-overlay text-zinc-300 rounded-lg hover:bg-surface-selected transition-colors border border-white/10 disabled:opacity-40"
          >
            Iterate
          </button>
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-3">
        <button
          onClick={onCreatePR}
          className="px-4 py-2 text-sm bg-accent hover:bg-accent-dim text-white rounded-lg transition-colors"
        >
          Create PR
        </button>
        <button
          onClick={onDiscard}
          className="px-4 py-2 text-sm bg-surface-overlay text-zinc-400 rounded-lg hover:bg-surface-selected transition-colors border border-white/10"
        >
          Discard
        </button>
      </div>
    </div>
  );
}
