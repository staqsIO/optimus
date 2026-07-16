"use client";

import { useEffect, useState, useMemo } from "react";
import { opsFetch } from "@/lib/ops-api";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type WordOp =
  | { type: "eq"; a: string; b: string }
  | { type: "add"; b: string }
  | { type: "del"; a: string };

type Block =
  | { type: "eq"; text: string }
  | { type: "add"; text: string }
  | { type: "del"; text: string }
  | { type: "replace"; words: WordOp[] };

interface DiffSide {
  id: string;
  version_number: number | null;
  label: string;
  change_source?: string;
  created_at: string;
}

interface DiffResponse {
  a: DiffSide;
  b: DiffSide;
  blocks: Block[];
  stats: {
    added: number;
    removed: number;
    paragraphs: { added: number; removed: number; changed: number; unchanged: number };
  };
}

interface VersionOption {
  id: string;
  version_number: number;
  change_source: string;
  created_at: string;
}

interface Props {
  contractId: string;
  versions: VersionOption[];
  initialA: string;
  initialB: string;
  onClose: () => void;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function ContractVersionDiff({ contractId, versions, initialA, initialB, onClose }: Props) {
  const [a, setA] = useState(initialA);
  const [b, setB] = useState(initialB);
  const [data, setData] = useState<DiffResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hideUnchanged, setHideUnchanged] = useState(false);
  const [view, setView] = useState<"unified" | "split">("unified");

  // Esc to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    if (!a || !b || a === b) {
      setData(null);
      return;
    }
    setLoading(true);
    setError(null);
    opsFetch<DiffResponse>(
      `/api/contracts/${contractId}/versions/diff?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`
    )
      .then((d) => {
        if (cancelled) return;
        if (!d) setError("Failed to load diff");
        else setData(d);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [contractId, a, b]);

  const versionOptions = useMemo(() => {
    return [
      { value: "current", label: "Current draft" },
      ...versions.map((v) => ({
        value: v.id,
        label: `v${v.version_number} · ${v.change_source} · ${new Date(v.created_at).toLocaleDateString()}`,
      })),
    ];
  }, [versions]);

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4 md:p-8 backdrop-blur-sm animate-fade-in"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-6xl h-[90vh] flex flex-col rounded-xl border border-zinc-700 bg-zinc-950 shadow-2xl"
      >
        {/* Header */}
        <div className="px-5 py-3 border-b border-zinc-800 flex items-center justify-between gap-4">
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-zinc-100">Compare versions</h2>
            <p className="text-[10px] text-zinc-500 mt-0.5">
              Side-by-side word diff between two snapshots of this contract.
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-200 text-xl leading-none px-2"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Picker bar */}
        <div className="px-5 py-3 border-b border-zinc-800 grid grid-cols-1 md:grid-cols-[1fr_auto_1fr_auto] gap-3 items-center">
          <VersionSelect
            label="From"
            value={a}
            options={versionOptions}
            tone="rose"
            onChange={setA}
          />
          <div className="hidden md:block text-zinc-600 text-xs px-2">→</div>
          <VersionSelect
            label="To"
            value={b}
            options={versionOptions}
            tone="emerald"
            onChange={setB}
          />
          <div className="flex items-center gap-2 justify-end">
            <button
              onClick={() => { const tmp = a; setA(b); setB(tmp); }}
              className="px-2 py-1 text-[10px] rounded border border-zinc-700 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
              title="Swap from/to"
            >
              ⇄ swap
            </button>
            <div className="flex rounded border border-zinc-700 overflow-hidden">
              <ToggleButton active={view === "unified"} onClick={() => setView("unified")}>Unified</ToggleButton>
              <ToggleButton active={view === "split"} onClick={() => setView("split")}>Split</ToggleButton>
            </div>
          </div>
        </div>

        {/* Stats */}
        <div className="px-5 py-2 border-b border-zinc-800 flex items-center gap-3 text-[11px]">
          {a === b ? (
            <span className="text-zinc-500">Pick two different versions to compare.</span>
          ) : loading ? (
            <span className="text-zinc-500">Loading diff…</span>
          ) : data ? (
            <>
              <span className="inline-flex items-center gap-1 text-emerald-300">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> +{data.stats.added}
              </span>
              <span className="inline-flex items-center gap-1 text-rose-300">
                <span className="w-1.5 h-1.5 rounded-full bg-rose-400" /> −{data.stats.removed}
              </span>
              <span className="text-zinc-500 hidden md:inline">
                · {data.stats.paragraphs.changed} changed, {data.stats.paragraphs.added} added, {data.stats.paragraphs.removed} removed, {data.stats.paragraphs.unchanged} unchanged paragraphs
              </span>
              <span className="ml-auto inline-flex items-center gap-2 text-zinc-500">
                <label className="inline-flex items-center gap-1.5 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={hideUnchanged}
                    onChange={(e) => setHideUnchanged(e.target.checked)}
                    className="rounded border-zinc-600 bg-zinc-800 text-amber-500 focus:ring-amber-500/50"
                  />
                  hide unchanged
                </label>
              </span>
            </>
          ) : null}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {error && (
            <div className="text-xs text-red-300 bg-red-500/10 border border-red-500/20 rounded px-3 py-2">
              {error}
            </div>
          )}
          {a === b && (
            <EmptyState>Pick two different versions above to see what changed.</EmptyState>
          )}
          {!error && a !== b && data && data.blocks.length === 0 && (
            <EmptyState>These two versions are identical.</EmptyState>
          )}
          {!error && a !== b && data && data.blocks.length > 0 && (
            view === "unified"
              ? <UnifiedDiff blocks={data.blocks} hideUnchanged={hideUnchanged} />
              : <SplitDiff blocks={data.blocks} hideUnchanged={hideUnchanged} />
          )}
        </div>
      </div>

      <style jsx global>{`
        @keyframes diff-fade-in { from { opacity: 0; } to { opacity: 1; } }
        .animate-fade-in { animation: diff-fade-in 120ms ease-out; }
      `}</style>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

function VersionSelect({
  label,
  value,
  onChange,
  options,
  tone,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  tone: "rose" | "emerald";
}) {
  const ring = tone === "rose" ? "focus:border-rose-500/50" : "focus:border-emerald-500/50";
  const dot = tone === "rose" ? "bg-rose-400" : "bg-emerald-400";
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-zinc-500 inline-flex items-center gap-1.5">
        <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full px-2 py-1.5 text-xs bg-zinc-900 border border-zinc-700 rounded text-zinc-200 focus:outline-none ${ring}`}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}

function ToggleButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 text-[10px] font-medium transition-colors ${
        active ? "bg-zinc-800 text-zinc-100" : "bg-zinc-950 text-zinc-500 hover:text-zinc-300"
      }`}
    >
      {children}
    </button>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full min-h-[200px] flex items-center justify-center text-xs text-zinc-500">
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Diff renderers                                                     */
/* ------------------------------------------------------------------ */

function UnifiedDiff({ blocks, hideUnchanged }: { blocks: Block[]; hideUnchanged: boolean }) {
  return (
    <div className="space-y-3 font-serif text-[13px] leading-relaxed text-zinc-300">
      {blocks.map((b, i) => {
        if (b.type === "eq") {
          if (hideUnchanged) return <UnchangedFold key={i} text={b.text} />;
          return <p key={i} className="whitespace-pre-wrap break-words">{b.text}</p>;
        }
        if (b.type === "add") {
          return (
            <p key={i} className="whitespace-pre-wrap break-words bg-emerald-500/10 border-l-2 border-emerald-500/60 pl-3 py-1 rounded-r">
              <Marker tone="add" />
              <span className="text-emerald-200">{b.text}</span>
            </p>
          );
        }
        if (b.type === "del") {
          return (
            <p key={i} className="whitespace-pre-wrap break-words bg-rose-500/10 border-l-2 border-rose-500/60 pl-3 py-1 rounded-r">
              <Marker tone="del" />
              <span className="text-rose-200 line-through decoration-rose-400/50">{b.text}</span>
            </p>
          );
        }
        // replace — render with inline word marks
        return (
          <p key={i} className="whitespace-pre-wrap break-words bg-amber-500/[0.04] border-l-2 border-amber-500/40 pl-3 py-1 rounded-r">
            <Marker tone="change" />
            {b.words.map((w, wi) => {
              if (w.type === "eq") return <span key={wi}>{w.a}</span>;
              if (w.type === "add") return <span key={wi} className="bg-emerald-500/25 text-emerald-100 rounded-sm px-0.5">{w.b}</span>;
              return <span key={wi} className="bg-rose-500/25 text-rose-100 rounded-sm px-0.5 line-through decoration-rose-300/60">{w.a}</span>;
            })}
          </p>
        );
      })}
    </div>
  );
}

function SplitDiff({ blocks, hideUnchanged }: { blocks: Block[]; hideUnchanged: boolean }) {
  // For split view we render each block as a row with two panes.
  // - eq: same text on both sides
  // - add: empty on the left, text on the right
  // - del: text on the left, empty on the right
  // - replace: per-side word stream (only the matching-side words)
  return (
    <div className="space-y-2 font-serif text-[12.5px] leading-relaxed">
      {blocks.map((b, i) => {
        const isUnchanged = b.type === "eq";
        if (isUnchanged && hideUnchanged) return <UnchangedFold key={i} text={b.text} />;

        const left =
          b.type === "eq" ? <span className="text-zinc-300">{b.text}</span> :
          b.type === "del" ? <span className="text-rose-200 line-through decoration-rose-400/50">{b.text}</span> :
          b.type === "replace" ? <SideWords words={b.words} side="a" /> :
          null;

        const right =
          b.type === "eq" ? <span className="text-zinc-300">{b.text}</span> :
          b.type === "add" ? <span className="text-emerald-200">{b.text}</span> :
          b.type === "replace" ? <SideWords words={b.words} side="b" /> :
          null;

        const leftBg =
          b.type === "del" ? "bg-rose-500/10 border-rose-500/40" :
          b.type === "replace" ? "bg-amber-500/[0.04] border-amber-500/30" :
          "border-zinc-800";

        const rightBg =
          b.type === "add" ? "bg-emerald-500/10 border-emerald-500/40" :
          b.type === "replace" ? "bg-amber-500/[0.04] border-amber-500/30" :
          "border-zinc-800";

        return (
          <div key={i} className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <div className={`whitespace-pre-wrap break-words border-l-2 pl-3 py-1 rounded-r ${leftBg}`}>{left || <span className="text-zinc-700">·</span>}</div>
            <div className={`whitespace-pre-wrap break-words border-l-2 pl-3 py-1 rounded-r ${rightBg}`}>{right || <span className="text-zinc-700">·</span>}</div>
          </div>
        );
      })}
    </div>
  );
}

function SideWords({ words, side }: { words: WordOp[]; side: "a" | "b" }) {
  return (
    <>
      {words.map((w, wi) => {
        if (w.type === "eq") return <span key={wi} className="text-zinc-300">{w.a}</span>;
        if (side === "a" && w.type === "del") {
          return <span key={wi} className="bg-rose-500/25 text-rose-100 rounded-sm px-0.5 line-through decoration-rose-300/60">{w.a}</span>;
        }
        if (side === "b" && w.type === "add") {
          return <span key={wi} className="bg-emerald-500/25 text-emerald-100 rounded-sm px-0.5">{w.b}</span>;
        }
        return null;
      })}
    </>
  );
}

function Marker({ tone }: { tone: "add" | "del" | "change" }) {
  const cls =
    tone === "add" ? "text-emerald-400" :
    tone === "del" ? "text-rose-400" :
    "text-amber-400";
  const ch = tone === "add" ? "+" : tone === "del" ? "−" : "~";
  return <span className={`inline-block w-3 mr-1.5 font-mono text-[11px] ${cls} select-none`}>{ch}</span>;
}

function UnchangedFold({ text }: { text: string }) {
  // Collapse long unchanged paragraphs to a single line; fully-unchanged
  // sections are visually deprioritized so the eye lands on changes.
  const preview = text.length > 120 ? `${text.slice(0, 80).trim()}…` : text.replace(/\s+/g, " ");
  return (
    <div className="text-[11px] text-zinc-600 italic px-3 py-1 border-l border-zinc-800 truncate select-none">
      ⋯ {preview}
    </div>
  );
}
