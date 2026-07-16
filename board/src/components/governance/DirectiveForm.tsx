"use client";

import { useState, useCallback } from "react";

interface DirectiveFormProps {
  onCreated?: () => void;
}

/**
 * Directive creation form — parity with CLI `directive <title>`.
 * Creates a top-level work_item of type='directive' assigned to orchestrator.
 */
export default function DirectiveForm({ onCreated }: DirectiveFormProps) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const submit = useCallback(async () => {
    const t = title.trim();
    if (!t) return;
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch("/api/governance?path=/api/governance/directive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: t,
          description: description.trim() || null,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${res.status}`);
      }
      const d = await res.json();
      setSuccess(`Directive created: ${d?.workItem?.id ?? "ok"}`);
      setTitle("");
      setDescription("");
      setOpen(false);
      onCreated?.();
      setTimeout(() => setSuccess(null), 4000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create directive");
    } finally {
      setSubmitting(false);
    }
  }, [title, description, onCreated]);

  if (!open) {
    return (
      <div className="space-y-2">
        <button
          onClick={() => setOpen(true)}
          className="w-full px-4 py-2.5 text-sm font-medium bg-accent-bright/20 text-accent-bright rounded-lg border border-accent-bright/30 hover:bg-accent-bright/30 transition-colors text-left"
        >
          + New Directive
          <span className="block text-[11px] text-zinc-500 font-normal mt-0.5">
            Inject a top-level priority into the task graph
          </span>
        </button>
        {success && (
          <div className="text-[11px] text-emerald-400">{success}</div>
        )}
      </div>
    );
  }

  return (
    <div className="p-4 bg-zinc-800/50 rounded-lg border border-white/10 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-zinc-200">New Directive</h3>
        <button
          onClick={() => { setOpen(false); setError(null); }}
          className="text-zinc-500 hover:text-zinc-300 transition-colors"
          aria-label="Close"
        >
          &times;
        </button>
      </div>

      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title (e.g. Prioritize investor emails this week)"
        maxLength={500}
        className="w-full px-3 py-2 text-sm bg-zinc-800 border border-white/10 rounded-lg text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-accent/50"
      />

      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description (optional)"
        rows={3}
        className="w-full px-3 py-2 text-sm bg-zinc-800 border border-white/10 rounded-lg text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-accent/50 resize-none"
      />

      {error && <div className="text-xs text-red-400">{error}</div>}

      <div className="flex gap-2 justify-end">
        <button
          onClick={() => { setOpen(false); setError(null); }}
          className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={submitting || !title.trim()}
          className="px-4 py-2 text-sm bg-accent-bright/20 text-accent-bright rounded-lg border border-accent-bright/30 hover:bg-accent-bright/30 transition-colors disabled:opacity-40"
        >
          {submitting ? "Creating..." : "Create directive"}
        </button>
      </div>
    </div>
  );
}
