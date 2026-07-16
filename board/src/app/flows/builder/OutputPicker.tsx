"use client";

import type { SignalCatalogEntry } from "./types";
import { getSignalLabel } from "./intent-labels";

export default function OutputPicker({
  signals,
  selected,
  onSelect,
}: {
  signals: SignalCatalogEntry[];
  selected: string | null;
  onSelect: (signalType: string | null) => void;
}) {
  return (
    <div className="space-y-1">
      <button
        onClick={() => onSelect(null)}
        className={`w-full text-left px-3 py-1.5 rounded text-xs transition-colors
          ${selected === null
            ? "bg-white/[0.06] text-zinc-200 border border-accent/30"
            : "text-zinc-500 hover:text-zinc-300 border border-white/5 hover:border-white/10"
          }`}
      >
        No output signal (end of chain)
      </button>
      {signals.map((s) => (
        <button
          key={s.signal_type}
          onClick={() => onSelect(s.signal_type)}
          className={`w-full text-left flex items-center gap-2 px-3 py-1.5 rounded text-xs transition-colors
            ${selected === s.signal_type
              ? "bg-white/[0.06] text-zinc-200 border border-accent/30"
              : "text-zinc-400 hover:text-zinc-200 border border-white/5 hover:border-white/10"
            }`}
        >
          <span className="flex-1 truncate">{getSignalLabel(s.signal_type)}</span>
          <span className="text-[10px] font-mono text-zinc-600 shrink-0">{s.signal_type}</span>
        </button>
      ))}
    </div>
  );
}
