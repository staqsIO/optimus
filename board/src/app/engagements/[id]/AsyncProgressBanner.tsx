"use client";

import { useEffect, useState } from "react";

type Progress = {
  stage?: string;
  current?: number;
  total?: number;
  label?: string;
  model?: string;
};

const STATUS_LABEL: Record<string, string> = {
  ingesting: "Ingesting sources",
  synthesizing: "Synthesizing spec",
  generating: "Generating proposal",
  drafting_contract: "Drafting contract",
};

const STATUS_TINT: Record<string, string> = {
  ingesting: "bg-blue-900/30 border-blue-700/40",
  synthesizing: "bg-emerald-900/30 border-emerald-700/40",
  generating: "bg-amber-900/30 border-amber-700/40",
  drafting_contract: "bg-violet-900/30 border-violet-700/40",
};

export default function AsyncProgressBanner({
  status,
  progress,
  startedAt,
}: {
  status: "ingesting" | "synthesizing" | "generating" | "drafting_contract";
  progress: Progress;
  startedAt: string | null;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const elapsedSec = startedAt
    ? Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000))
    : null;

  const pct =
    typeof progress.current === "number" && typeof progress.total === "number" && progress.total > 0
      ? Math.min(100, Math.round((progress.current / progress.total) * 100))
      : null;

  const showBar = status === "ingesting" && pct !== null;

  return (
    <div
      className={`border-b ${STATUS_TINT[status] || "bg-zinc-900/40 border-white/10"} px-6 py-3`}
    >
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center gap-3">
          <Spinner />
          <div className="flex-1 min-w-0">
            <div className="text-sm text-zinc-100 font-medium">
              {STATUS_LABEL[status] || "Working"}
              {elapsedSec !== null && (
                <span className="text-xs text-zinc-400 ml-2">
                  ({fmtElapsed(elapsedSec)})
                </span>
              )}
            </div>
            {progress.label && (
              <div className="text-xs text-zinc-400 mt-0.5 truncate">{progress.label}</div>
            )}
            {progress.model && (
              <div className="text-[10px] text-zinc-500 mt-0.5">model: {progress.model}</div>
            )}
          </div>
          {showBar && (
            <div className="text-xs text-zinc-300 tabular-nums">
              {progress.current}/{progress.total}
            </div>
          )}
        </div>
        {showBar && (
          <div className="mt-2 h-1.5 bg-zinc-800 rounded overflow-hidden">
            <div
              className="h-full bg-blue-500 transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <div className="w-4 h-4 border-2 border-zinc-600 border-t-zinc-200 rounded-full animate-spin shrink-0" />
  );
}

function fmtElapsed(sec: number): string {
  if (sec < 60) return `${sec}s elapsed`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s elapsed`;
}
