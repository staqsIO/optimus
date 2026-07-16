"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { type Draft } from "./QueueItem";

// ---------------------------------------------------------------------------
// DraftCompose — Inline editable draft
// ---------------------------------------------------------------------------

export default function DraftCompose({
  draft,
  isEditing,
  onSetEditing,
  onSave,
  onCancel,
  submitting,
  readOnly,
}: {
  draft: Draft;
  isEditing: boolean;
  onSetEditing: (editing: boolean) => void;
  onSave: (body: string) => void;
  onCancel: () => void;
  submitting: boolean;
  /** No editing — for stakeholder demo (no API writes). */
  readOnly?: boolean;
}) {
  const [editedBody, setEditedBody] = useState(draft.body);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Reset edited body when draft changes
  useEffect(() => {
    setEditedBody(draft.body);
  }, [draft.id, draft.body]);

  // Auto-focus and auto-height textarea when entering edit mode
  useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.focus();
      autoResize(textareaRef.current);
    }
  }, [isEditing]);

  const autoResize = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setEditedBody(e.target.value);
    autoResize(e.target);
  };

  // Cmd+Enter to save
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        if (editedBody !== draft.body) {
          onSave(editedBody);
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    },
    [editedBody, draft.body, onSave, onCancel],
  );

  const hasVersion = (draft.version ?? 1) > 1;

  return (
    <div className="px-4 py-4">
      {/* Label */}
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs uppercase tracking-wider text-zinc-500">
          AI Draft
        </span>
        {hasVersion && (
          <span className="text-[10px] text-zinc-600 tabular-nums">
            v{draft.version}
          </span>
        )}
      </div>

      {/* Draft bubble */}
      <div
        className={`rounded-2xl p-4 transition-all duration-150 ${
          isEditing
            ? "border-2 border-blue-500/30 bg-zinc-900/70"
            : readOnly
              ? "border border-blue-500/15 bg-zinc-900/50 cursor-default"
              : "border border-blue-500/15 bg-zinc-900/50 cursor-pointer hover:border-blue-500/25"
        }`}
        onClick={() => {
          if (!readOnly && !isEditing) onSetEditing(true);
        }}
      >
        {isEditing ? (
          <textarea
            ref={textareaRef}
            className="w-full bg-transparent text-sm text-zinc-200 font-sans
                     resize-none focus:outline-none leading-relaxed min-h-[120px]"
            value={editedBody}
            onChange={handleTextChange}
            onKeyDown={handleKeyDown}
            rows={Math.max(6, editedBody.split("\n").length + 2)}
          />
        ) : (
          <pre className="text-sm text-zinc-300 whitespace-pre-wrap font-sans leading-relaxed">
            {draft.body}
          </pre>
        )}
      </div>

      {/* Edit toolbar */}
      {isEditing && !readOnly && (
        <div className="flex items-center gap-2 mt-3">
          <button
            onClick={() => onCancel()}
            className="px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => onSave(editedBody)}
            disabled={submitting || editedBody === draft.body}
            className="px-4 py-1.5 text-sm bg-accent/15 text-accent-bright rounded-lg
                     hover:bg-accent/25 transition-colors disabled:opacity-50 font-medium"
          >
            {submitting ? "Saving..." : "Save Draft"}
          </button>
          <button
            onClick={() => {
              onSave(editedBody);
            }}
            disabled={submitting || editedBody === draft.body}
            className="px-4 py-1.5 text-sm bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg
                     transition-colors disabled:opacity-50 font-medium"
          >
            {submitting ? "Sending..." : "Approve & Send"}
          </button>
          <span className="text-[10px] text-zinc-600 ml-auto hidden md:block">
            <kbd className="px-1 py-0.5 rounded bg-surface-overlay border border-white/5 font-mono">Cmd+Enter</kbd> to send
          </span>
        </div>
      )}
    </div>
  );
}
