"use client";

import { parseBracket } from "./BracketDecorationPlugin";

interface VariablePanelProps {
  usedBrackets: string[];
  availableVars: string[];
  onJump: (name: string) => void;
  onInsert: (name: string) => void;
}

const TYPE_BADGE_CLASS: Record<string, string> = {
  DATE:     "bg-sky-500/20 text-sky-300",
  CURRENCY: "bg-emerald-500/20 text-emerald-300",
  SIGNER:   "bg-violet-500/20 text-violet-300",
  TEXT:     "bg-zinc-700/60 text-zinc-400",
};

function TypeBadge({ type }: { type: string | null }) {
  if (!type) return null;
  const cls = TYPE_BADGE_CLASS[type] || "bg-amber-500/20 text-amber-300";
  return (
    <span className={`px-1 py-0.5 text-[8px] font-mono rounded ${cls}`} title={`Typed ${type}`}>
      {type.toLowerCase()}
    </span>
  );
}

export default function VariablePanel({ usedBrackets, availableVars, onJump, onInsert }: VariablePanelProps) {
  const hasAny = usedBrackets.length > 0 || availableVars.length > 0;
  if (!hasAny) return null;

  return (
    <div className="flex flex-col">
      {/* Header */}
      <div className="px-3 py-2.5 border-b border-zinc-800 border-t border-t-zinc-800/60">
        <h3 className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider">Variables</h3>
        <p className="text-[10px] text-zinc-600 mt-0.5">
          {usedBrackets.length} unfilled · {availableVars.length} available
        </p>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Used brackets (unfilled placeholders in the doc) */}
        {usedBrackets.length > 0 && (
          <div className="py-1">
            <div className="px-3 py-1 text-[9px] font-semibold text-amber-500/70 uppercase tracking-wider">
              In document · click to jump
            </div>
            {usedBrackets.map((raw) => {
              const parsed = parseBracket(raw);
              return (
                <button
                  key={`used-${raw}`}
                  onClick={() => onJump(raw)}
                  className="w-full text-left px-3 py-1.5 hover:bg-amber-500/5 transition-colors flex items-center gap-2 group"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse shrink-0" />
                  <TypeBadge type={parsed.type} />
                  <span className="text-[11px] font-mono text-amber-300 truncate flex-1">
                    {parsed.name}
                  </span>
                  <span className="text-zinc-700 group-hover:text-amber-500/70 text-[10px] shrink-0">→</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Available variables (from template catalog, not yet inserted) */}
        {availableVars.length > 0 && (
          <div className="py-1 border-t border-zinc-800/50">
            <div className="px-3 py-1 text-[9px] font-semibold text-zinc-500 uppercase tracking-wider">
              Available · click to insert
            </div>
            {availableVars.map((raw) => {
              const parsed = parseBracket(raw);
              return (
                <button
                  key={`avail-${raw}`}
                  onClick={() => onInsert(raw)}
                  className="w-full text-left px-3 py-1.5 hover:bg-white/5 transition-colors flex items-center gap-2 group"
                  title={`Insert [${raw}] at cursor`}
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-zinc-700 shrink-0" />
                  <TypeBadge type={parsed.type} />
                  <span className="text-[11px] font-mono text-zinc-500 truncate flex-1">
                    {parsed.name}
                  </span>
                  <span className="text-zinc-800 group-hover:text-zinc-500 text-[10px] shrink-0">+</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer hint */}
      <div className="px-3 py-2 border-t border-zinc-800 bg-zinc-950">
        <p className="text-[9px] text-zinc-600 leading-relaxed">
          Type over a bracket to fill it. The highlight disappears once replaced.
        </p>
      </div>
    </div>
  );
}
