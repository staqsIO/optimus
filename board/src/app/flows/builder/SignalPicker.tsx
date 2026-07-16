"use client";

import { useState, useMemo } from "react";
import type { SignalCatalogEntry } from "./types";
import { getSignalLabel, SIGNAL_LABELS } from "./intent-labels";

const ADAPTER_BADGE: Record<string, string> = {
  gmail:    "bg-red-500/20 text-red-400 border-red-500/30",
  slack:    "bg-purple-500/20 text-purple-400 border-purple-500/30",
  webhook:  "bg-amber-500/20 text-amber-400 border-amber-500/30",
  telegram: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  internal: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
  api:      "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
};

export default function SignalPicker({
  signals,
  selected,
  onSelect,
}: {
  signals: SignalCatalogEntry[];
  selected: string | null;
  onSelect: (signalType: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [adapter, setAdapter] = useState<string>("all");

  // Adapter types present in the catalog (gmail/slack/webhook/meeting/…), for the
  // filter chips. Derived from the data so new adapters surface automatically.
  const adapters = useMemo(
    () => Array.from(new Set(signals.map((s) => s.source_adapter))).sort(),
    [signals],
  );

  const grouped = useMemo(() => {
    const q = search.toLowerCase();
    const filtered = signals.filter(
      (s) =>
        (adapter === "all" || s.source_adapter === adapter) &&
        (s.label.toLowerCase().includes(q) ||
          s.signal_type.toLowerCase().includes(q) ||
          s.source_adapter.toLowerCase().includes(q)),
    );
    const groups: Record<string, SignalCatalogEntry[]> = {};
    for (const s of filtered) {
      const cat = s.category || "Other";
      (groups[cat] ??= []).push(s);
    }
    return groups;
  }, [signals, search, adapter]);

  if (selected) {
    const label = getSignalLabel(selected);
    const info = SIGNAL_LABELS[selected];
    return (
      <div className="flex items-center gap-3 px-3 py-2 rounded-lg border border-white/10 bg-white/[0.02]">
        <span className="text-emerald-400 text-xs">&#10003;</span>
        <span className="text-sm text-zinc-200">{label}</span>
        <span className="text-[10px] font-mono text-zinc-600">{selected}</span>
        {info && (
          <span className={`ml-auto inline-flex px-1.5 py-0.5 text-[10px] font-mono rounded border ${ADAPTER_BADGE[signals.find(s => s.signal_type === selected)?.source_adapter ?? "internal"] ?? ADAPTER_BADGE.internal}`}>
            {signals.find(s => s.signal_type === selected)?.source_adapter ?? "internal"}
          </span>
        )}
        <button
          onClick={() => onSelect("")}
          className="text-xs text-zinc-600 hover:text-zinc-400 ml-2"
        >
          change
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {adapters.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            onClick={() => setAdapter("all")}
            className={`px-2 py-0.5 text-[10px] font-mono rounded border transition-colors ${
              adapter === "all"
                ? "bg-white/10 text-zinc-100 border-white/20"
                : "text-zinc-500 border-white/5 hover:text-zinc-300"
            }`}
          >
            all
          </button>
          {adapters.map((a) => (
            <button
              key={a}
              onClick={() => setAdapter(a)}
              className={`px-2 py-0.5 text-[10px] font-mono rounded border transition-colors ${
                adapter === a
                  ? ADAPTER_BADGE[a] ?? ADAPTER_BADGE.internal
                  : "text-zinc-500 border-white/5 hover:text-zinc-300"
              }`}
            >
              {a}
            </button>
          ))}
        </div>
      )}

      <input
        type="text"
        placeholder="Search signals..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full px-3 py-1.5 text-xs bg-white/[0.04] border border-white/10 rounded text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-accent/50"
      />

      {Object.keys(grouped).length === 0 ? (
        <div className="text-xs text-zinc-600 text-center py-4">No matching signals</div>
      ) : (
        Object.entries(grouped).map(([category, items]) => (
          <div key={category}>
            <div className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest mb-1.5">
              {category}
            </div>
            <div className="space-y-1">
              {items.map((s) => (
                <button
                  key={s.signal_type}
                  onClick={() => onSelect(s.signal_type)}
                  className="w-full text-left flex items-center gap-3 px-3 py-2 rounded-lg border border-white/5 hover:border-accent/30 hover:bg-white/[0.03] transition-colors"
                >
                  <span className="text-sm text-zinc-200">{s.label}</span>
                  <span className="text-[10px] font-mono text-zinc-600 ml-auto">{s.signal_type}</span>
                  <span className={`inline-flex px-1.5 py-0.5 text-[10px] font-mono rounded border ${ADAPTER_BADGE[s.source_adapter] ?? ADAPTER_BADGE.internal}`}>
                    {s.source_adapter}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
