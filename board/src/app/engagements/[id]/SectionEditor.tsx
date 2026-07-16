"use client";

import { useEffect, useState } from "react";
import type { Section } from "./EngagementClient";

export default function SectionEditor({
  section,
  onSave,
  onTogglePin,
  onReorder,
  onDelete,
  onShowHistory,
  isFirst,
  isLast,
}: {
  section: Section;
  onSave: (body: string) => Promise<void>;
  onTogglePin: () => Promise<void>;
  onReorder: (dir: "up" | "down") => Promise<void>;
  onDelete: () => Promise<void>;
  onShowHistory?: () => void;
  isFirst: boolean;
  isLast: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(section.body);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(section.body);
  }, [section.body, editing]);

  const pinned = section.pin_state === "pinned";

  async function save() {
    if (draft === section.body) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onSave(draft);
      setEditing(false);
    } catch (err) {
      alert(`Save failed: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className={`border rounded ${pinned ? "border-amber-700/50" : "border-white/10"}`}
    >
      <div className="flex items-center justify-between px-3 py-2 bg-zinc-900/50 border-b border-white/5">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-zinc-100">{section.title}</h3>
          {section.is_core && (
            <span className="text-[9px] uppercase tracking-wider text-zinc-500 bg-zinc-800 px-1 py-0.5 rounded">
              core
            </span>
          )}
          {pinned && (
            <span className="text-[9px] uppercase tracking-wider text-amber-400 bg-amber-900/30 px-1 py-0.5 rounded">
              📌 pinned
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {section.last_human_edit_at && (
            <span className="text-[10px] text-zinc-500" title={section.last_human_edit_at}>
              edited by {section.last_human_edit_by}
            </span>
          )}
          <button
            onClick={() => onReorder("up")}
            disabled={isFirst}
            className="text-[10px] text-zinc-500 hover:text-zinc-300 px-1 py-0.5 rounded hover:bg-zinc-800 disabled:opacity-25 disabled:hover:bg-transparent transition-colors"
            title="Move up"
          >
            ↑
          </button>
          <button
            onClick={() => onReorder("down")}
            disabled={isLast}
            className="text-[10px] text-zinc-500 hover:text-zinc-300 px-1 py-0.5 rounded hover:bg-zinc-800 disabled:opacity-25 disabled:hover:bg-transparent transition-colors"
            title="Move down"
          >
            ↓
          </button>
          <button
            onClick={onTogglePin}
            className="text-[10px] uppercase tracking-wider text-zinc-500 hover:text-zinc-300 px-1.5 py-0.5 rounded hover:bg-zinc-800 transition-colors"
            title={pinned ? "Unpin — let synth update this section" : "Pin — lock against synth"}
          >
            {pinned ? "unpin" : "pin"}
          </button>
          {onShowHistory && (
            <button
              onClick={onShowHistory}
              className="text-[10px] uppercase tracking-wider text-zinc-500 hover:text-zinc-300 px-1.5 py-0.5 rounded hover:bg-zinc-800 transition-colors"
              title="View this section's edit history"
            >
              history
            </button>
          )}
          {!editing && (
            <button
              onClick={() => setEditing(true)}
              className="text-[10px] uppercase tracking-wider text-zinc-400 hover:text-emerald-300 px-1.5 py-0.5 rounded hover:bg-zinc-800 transition-colors"
            >
              edit
            </button>
          )}
          <button
            onClick={() => {
              if (confirm(`Delete section "${section.title}"? This cannot be undone.`)) {
                onDelete();
              }
            }}
            className="text-[10px] uppercase tracking-wider text-zinc-500 hover:text-red-400 px-1.5 py-0.5 rounded hover:bg-zinc-800 transition-colors"
            title="Delete this section"
          >
            del
          </button>
        </div>
      </div>

      {editing ? (
        <div className="p-3">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={Math.max(6, draft.split("\n").length + 1)}
            className="w-full px-3 py-2 text-sm bg-zinc-950 border border-white/10 rounded text-zinc-200 font-mono focus:outline-none focus:border-emerald-500 resize-y"
            autoFocus
          />
          <div className="flex gap-2 mt-2">
            <button
              onClick={save}
              disabled={saving}
              className="px-3 py-1 text-xs bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white rounded"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              onClick={() => {
                setDraft(section.body);
                setEditing(false);
              }}
              className="px-3 py-1 text-xs text-zinc-400 bg-zinc-800 hover:bg-zinc-700 rounded"
            >
              Cancel
            </button>
            {!pinned && (
              <span className="text-[10px] text-zinc-600 self-center ml-auto">
                Edits boost this section's weight in future synth passes.
              </span>
            )}
          </div>
        </div>
      ) : (
        <div className="p-3">
          {section.body ? (
            <pre className="text-sm text-zinc-200 whitespace-pre-wrap font-sans leading-relaxed">
              {section.body}
            </pre>
          ) : (
            <div className="text-xs text-zinc-600 italic">(empty)</div>
          )}
          {section.provenance.length > 0 && (
            <div className="text-[10px] text-zinc-600 mt-3 pt-2 border-t border-white/5">
              from {section.provenance.length} proposal
              {section.provenance.length === 1 ? "" : "s"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
