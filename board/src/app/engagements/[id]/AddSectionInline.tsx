"use client";

import { useState } from "react";

export default function AddSectionInline({
  onAdd,
}: {
  onAdd: (title: string, body: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!title.trim()) return;
    setSaving(true);
    try {
      await onAdd(title.trim(), body);
      setTitle("");
      setBody("");
      setOpen(false);
    } catch (err) {
      alert(`Add failed: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <div className="mt-4">
        <button
          onClick={() => setOpen(true)}
          className="w-full px-3 py-2 text-xs text-zinc-500 hover:text-zinc-300 border border-dashed border-white/10 hover:border-white/20 rounded transition-colors"
        >
          + Add section
        </button>
      </div>
    );
  }

  return (
    <div className="mt-4 border border-white/10 rounded">
      <div className="px-3 py-2 bg-zinc-900/50 border-b border-white/5">
        <div className="text-xs uppercase tracking-wider text-zinc-500">New section</div>
      </div>
      <div className="p-3 space-y-2">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Section title (e.g. Integrations, Compliance)"
          className="w-full px-3 py-2 text-sm bg-zinc-950 border border-white/10 rounded text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500"
          autoFocus
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={6}
          placeholder="Markdown body (optional)"
          className="w-full px-3 py-2 text-sm bg-zinc-950 border border-white/10 rounded text-zinc-200 font-mono placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500 resize-y"
        />
        <div className="flex items-center gap-2">
          <button
            onClick={submit}
            disabled={saving || !title.trim()}
            className="px-3 py-1 text-xs bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white rounded"
          >
            {saving ? "Adding…" : "Add"}
          </button>
          <button
            onClick={() => {
              setTitle("");
              setBody("");
              setOpen(false);
            }}
            className="px-3 py-1 text-xs text-zinc-400 bg-zinc-800 hover:bg-zinc-700 rounded"
          >
            Cancel
          </button>
          <span className="text-[10px] text-zinc-600 ml-auto">
            New sections are pinned by default so synth won't rewrite them.
          </span>
        </div>
      </div>
    </div>
  );
}
