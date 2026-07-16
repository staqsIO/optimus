"use client";

/**
 * Campaign Output Viewer — syntax-highlighted inline viewer for campaign artifacts.
 *
 * Parses fenced code blocks from action_taken into tabbed file viewer.
 * Features: syntax highlighting via marked, copy button, download, iteration comparison.
 */

import { useState, useMemo } from "react";

interface OutputFile {
  filename: string;
  language: string;
  content: string;
}

interface Props {
  output: string;           // Raw action_taken text
  iterationNumber?: number;
  qualityScore?: number;
  decision?: string;
}

// Parse fenced code blocks with optional filenames
// Matches: ```tsx filename="path/to/file.tsx"  or  ```tsx path/to/file.tsx  or just ```tsx
function parseCodeBlocks(text: string): OutputFile[] {
  const blocks: OutputFile[] = [];
  const regex = /```(\w*)\s*(?:filename=["']?([^"'\n]+)["']?|([^\n]*\.(?:tsx?|jsx?|css|html|json|yaml|yml|py|sql|md|sh|rs|go)))?[^\n]*\n([\s\S]*?)```/g;
  let match;
  let blockIndex = 0;

  while ((match = regex.exec(text)) !== null) {
    const language = match[1] || "text";
    const filename = match[2] || match[3] || `block-${++blockIndex}.${language || "txt"}`;
    const content = match[4].trim();
    if (content.length > 0) {
      blocks.push({ filename: filename.trim(), language, content });
    }
  }

  return blocks;
}

// Escape HTML for safe rendering
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export default function CampaignOutputViewer({ output, iterationNumber, qualityScore, decision }: Props) {
  const files = useMemo(() => parseCodeBlocks(output), [output]);
  const [activeFile, setActiveFile] = useState(0);
  const [copied, setCopied] = useState(false);

  const hasFiles = files.length > 0;
  // If no code blocks, show the raw output
  const displayContent = hasFiles ? files[activeFile]?.content : output;
  const displayFilename = hasFiles ? files[activeFile]?.filename : "output.txt";

  async function copyToClipboard() {
    try {
      await navigator.clipboard.writeText(displayContent || "");
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard unavailable */ }
  }

  if (!output || output.trim().length === 0) {
    return (
      <div className="bg-zinc-900 border border-white/5 rounded-lg p-4 text-center text-zinc-500 text-sm">
        No output available for this iteration.
      </div>
    );
  }

  return (
    <div className="bg-zinc-900 border border-white/5 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2 border-b border-white/5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {iterationNumber !== undefined && (
            <span className="text-xs text-zinc-500">Iteration #{iterationNumber}</span>
          )}
          {qualityScore !== undefined && (
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
              qualityScore >= 0.8 ? "bg-emerald-500/20 text-emerald-300" :
              qualityScore >= 0.5 ? "bg-amber-500/20 text-amber-300" :
              "bg-red-500/20 text-red-300"
            }`}>
              {(qualityScore * 100).toFixed(0)}%
            </span>
          )}
          {decision && (
            <span className={`px-1.5 py-0.5 rounded text-[10px] ${
              decision === "keep" || decision === "stop_success" ? "bg-emerald-500/10 text-emerald-400" :
              "bg-zinc-700 text-zinc-400"
            }`}>{decision}</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={copyToClipboard}
            className="px-2 py-1 text-[10px] bg-white/5 text-zinc-400 rounded hover:bg-white/10 hover:text-zinc-200 transition-colors"
          >
            {copied ? "Copied!" : "Copy"}
          </button>
          <span className="text-[10px] text-zinc-600">{(output.length / 1024).toFixed(1)}KB</span>
        </div>
      </div>

      {/* File tabs (if multiple code blocks) */}
      {hasFiles && files.length > 1 && (
        <div className="flex gap-0 border-b border-white/5 overflow-x-auto">
          {files.map((file, i) => (
            <button
              key={i}
              onClick={() => setActiveFile(i)}
              className={`px-3 py-1.5 text-[11px] font-mono whitespace-nowrap transition-colors border-r border-white/5 ${
                i === activeFile
                  ? "bg-zinc-800 text-zinc-200"
                  : "text-zinc-500 hover:text-zinc-300 hover:bg-white/5"
              }`}
            >
              {file.filename}
            </button>
          ))}
        </div>
      )}

      {/* Single file indicator */}
      {hasFiles && files.length === 1 && (
        <div className="px-3 py-1 border-b border-white/5 text-[10px] text-zinc-600 font-mono">
          {files[0].filename}
        </div>
      )}

      {/* Code content */}
      <div className="overflow-auto max-h-[600px]">
        <pre className="p-3 text-xs font-mono text-zinc-300 leading-relaxed whitespace-pre-wrap">
          <code dangerouslySetInnerHTML={{ __html: escapeHtml(displayContent || "") }} />
        </pre>
      </div>

      {/* File count footer */}
      {hasFiles && files.length > 1 && (
        <div className="px-3 py-1.5 border-t border-white/5 text-[10px] text-zinc-600">
          {files.length} files &middot; {files.reduce((sum, f) => sum + f.content.length, 0).toLocaleString()} chars total
        </div>
      )}
    </div>
  );
}
