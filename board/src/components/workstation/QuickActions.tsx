"use client";

import type { QuickAction } from "./types";

interface QuickActionsProps {
  actions: QuickAction[];
  onSelect: (action: QuickAction) => void;
}

export default function QuickActions({ actions, onSelect }: QuickActionsProps) {
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-medium text-zinc-400">Quick actions</h2>
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        {actions.map((action) => (
          <button
            key={action.id}
            onClick={() => onSelect(action)}
            className="flex flex-col items-start gap-2 p-4 bg-surface-raised rounded-lg border border-white/5 hover:border-accent/30 hover:bg-surface-overlay transition-colors text-left group"
          >
            <span className="text-lg">{action.icon}</span>
            <span className="text-sm text-zinc-300 group-hover:text-zinc-100 transition-colors">
              {action.label}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
