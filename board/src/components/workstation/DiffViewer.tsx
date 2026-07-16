"use client";

import { useState } from "react";
import type { DiffLine } from "./types";
import { groupDiffLines, type DiffGroup } from "@/lib/diff";

interface DiffViewerProps {
  lines: DiffLine[];
  contextLines?: number;
  maxHeight?: string;
}

function CollapsedBlock({ group, onExpand }: { group: DiffGroup; onExpand: () => void }) {
  return (
    <button
      onClick={onExpand}
      className="flex items-center w-full px-3 py-1.5 text-[10px] text-zinc-600 hover:text-zinc-400 hover:bg-white/[0.02] transition-colors bg-surface-overlay/30 border-y border-white/5 gap-2"
    >
      <svg className="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m6-6H6" />
      </svg>
      <span>{group.lines.length} lines unchanged</span>
    </button>
  );
}

function DiffLineRow({ line }: { line: DiffLine }) {
  const bgClass =
    line.type === "add"
      ? "bg-green-500/10"
      : line.type === "remove"
      ? "bg-red-500/10"
      : "";

  const textClass =
    line.type === "add"
      ? "text-green-400"
      : line.type === "remove"
      ? "text-red-400"
      : "text-zinc-500";

  const prefix = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";

  return (
    <div className={`flex text-xs font-mono leading-5 ${bgClass}`}>
      {/* Old line number gutter */}
      <span className="w-10 flex-shrink-0 text-right pr-2 text-zinc-700 select-none border-r border-white/5">
        {line.oldLineNo ?? ""}
      </span>
      {/* New line number gutter */}
      <span className="w-10 flex-shrink-0 text-right pr-2 text-zinc-700 select-none border-r border-white/5">
        {line.newLineNo ?? ""}
      </span>
      {/* +/- prefix */}
      <span className={`w-5 flex-shrink-0 text-center select-none ${textClass}`}>
        {prefix}
      </span>
      {/* Content */}
      <span className={`px-2 whitespace-pre-wrap break-all flex-1 ${textClass}`}>
        {line.content}
      </span>
    </div>
  );
}

export default function DiffViewer({ lines, contextLines = 3, maxHeight = "max-h-96" }: DiffViewerProps) {
  const initialGroups = groupDiffLines(lines, contextLines);
  const [expandedIndices, setExpandedIndices] = useState<Set<number>>(new Set());

  const toggleExpand = (index: number) => {
    setExpandedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  return (
    <div className={`rounded-md bg-surface border border-white/5 overflow-hidden ${maxHeight} overflow-y-auto`}>
      <div className="overflow-x-auto">
        {initialGroups.map((group, gi) => {
          if (group.type === "collapsed" && !expandedIndices.has(gi)) {
            return <CollapsedBlock key={gi} group={group} onExpand={() => toggleExpand(gi)} />;
          }
          return group.lines.map((line, li) => (
            <DiffLineRow key={`${gi}-${li}`} line={line} />
          ));
        })}
      </div>
    </div>
  );
}
