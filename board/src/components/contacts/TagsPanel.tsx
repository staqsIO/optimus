"use client";

import { useEffect, useState, useCallback } from "react";
import { opsFetch, opsPost, opsDelete } from "@/lib/ops-api";

interface TagRow {
  tag: string;
  created_by: string | null;
  created_at: string;
}

export default function TagsPanel({ contactId }: { contactId: string }) {
  const [tags, setTags] = useState<TagRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState("");

  const refresh = useCallback(async () => {
    const resp = await opsFetch<{ tags: TagRow[] }>(`/api/contacts/${contactId}/tags`);
    setTags(resp?.tags || []);
    setLoading(false);
  }, [contactId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const addTag = useCallback(async () => {
    const tag = adding.trim();
    if (!tag) return;
    const result = await opsPost<{ tag: TagRow }>(`/api/contacts/${contactId}/tags`, { tag });
    if (result.ok) {
      setAdding("");
      await refresh();
    }
  }, [adding, contactId, refresh]);

  const removeTag = useCallback(
    async (tag: string) => {
      const result = await opsDelete<{ ok: true }>(
        `/api/contacts/${contactId}/tags/${encodeURIComponent(tag)}`,
      );
      if (result.ok) await refresh();
    },
    [contactId, refresh],
  );

  return (
    <div className="bg-zinc-900 border border-white/5 rounded-lg p-4">
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="text-sm font-medium text-zinc-300">Tags</h3>
        <span className="text-[10px] text-zinc-600">free-form labels</span>
      </div>

      {loading ? (
        <p className="text-xs text-zinc-500">Loading…</p>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5 mb-3">
          {tags.length === 0 ? (
            <p className="text-xs text-zinc-600 italic">No tags yet.</p>
          ) : (
            tags.map((t) => (
              <span
                key={t.tag}
                className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded border border-white/10 bg-white/[0.02] text-zinc-200"
              >
                {t.tag}
                <button
                  onClick={() => removeTag(t.tag)}
                  className="text-zinc-500 hover:text-rose-400 ml-0.5"
                  aria-label={`remove ${t.tag}`}
                >
                  ×
                </button>
              </span>
            ))
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        <input
          type="text"
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") addTag();
          }}
          placeholder="add a tag…"
          maxLength={64}
          className="flex-1 px-2 py-1 text-xs bg-zinc-900 border border-white/10 rounded text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-violet-500/40"
        />
        <button
          onClick={addTag}
          disabled={!adding.trim()}
          className="text-xs px-2 py-1 rounded border border-white/10 text-zinc-300 hover:bg-white/5 disabled:opacity-40"
        >
          add
        </button>
      </div>
    </div>
  );
}
