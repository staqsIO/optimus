"use client";

import { useState, useMemo } from "react";
import type { ToolCatalogEntry } from "./types";
import { getToolLabel } from "./intent-labels";

const MODE_BADGE: Record<string, string> = {
  function: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  agent:    "bg-violet-500/20 text-violet-400 border-violet-500/30",
  hybrid:   "bg-blue-500/20 text-blue-400 border-blue-500/30",
};

const NATIVE_BADGE = "bg-sky-500/20 text-sky-300 border-sky-500/30";

export default function ToolPicker({
  tools,
  onSelect,
  onClose,
}: {
  tools: ToolCatalogEntry[];
  onSelect: (toolId: string) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");

  const grouped = useMemo(() => {
    const q = search.toLowerCase();
    const filtered = tools.filter(
      (t) =>
        getToolLabel(t.tool_id).toLowerCase().includes(q) ||
        t.tool_id.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q),
    );
    const groups: Record<string, ToolCatalogEntry[]> = {};
    for (const t of filtered) {
      const cat = t.category.charAt(0).toUpperCase() + t.category.slice(1);
      (groups[cat] ??= []).push(t);
    }
    return groups;
  }, [tools, search]);

  return (
    <div className="fixed inset-0 z-50 bg-zinc-950/90 flex items-center justify-center p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg bg-surface-raised border border-white/10 rounded-xl shadow-2xl flex flex-col max-h-[70vh]"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <span className="text-xs font-semibold text-zinc-300 uppercase tracking-widest">Choose Action</span>
          <button onClick={onClose} className="text-xs text-zinc-600 hover:text-zinc-300">
            esc
          </button>
        </div>

        {/* Search */}
        <div className="px-4 py-2 border-b border-white/5">
          <input
            type="text"
            autoFocus
            placeholder="Search tools..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && onClose()}
            className="w-full px-3 py-1.5 text-xs bg-white/[0.04] border border-white/10 rounded text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-accent/50"
          />
        </div>

        {/* Tool list */}
        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          {Object.keys(grouped).length === 0 ? (
            <div className="text-xs text-zinc-600 text-center py-6">No matching tools</div>
          ) : (
            Object.entries(grouped).map(([category, items]) => (
              <div key={category}>
                <div className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest mb-1.5">
                  {category}
                </div>
                <div className="space-y-1">
                  {items.map((t) => (
                    <button
                      key={t.tool_id}
                      onClick={() => { onSelect(t.tool_id); onClose(); }}
                      className="w-full text-left flex items-center gap-3 px-3 py-2 rounded-lg border border-white/5 hover:border-accent/30 hover:bg-white/[0.03] transition-colors"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-zinc-200 truncate">{getToolLabel(t.tool_id)}</div>
                        {t.description && (
                          <div className="text-[10px] text-zinc-600 truncate mt-0.5">{t.description}</div>
                        )}
                      </div>
                      <div className="shrink-0 flex items-center gap-1">
                        {t.native && (
                          <span
                            className={`inline-flex px-1.5 py-0.5 text-[10px] font-mono rounded border ${NATIVE_BADGE}`}
                            title="Flow-native tool or agent"
                          >
                            flow-native
                          </span>
                        )}
                        <span className={`inline-flex px-1.5 py-0.5 text-[10px] font-mono rounded border ${MODE_BADGE[t.dispatch_mode] ?? MODE_BADGE.function}`}>
                          {t.dispatch_mode}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
