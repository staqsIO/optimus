"use client";

import { useState, useCallback } from "react";

const CONTENT_TYPES = [
  { value: "idea", label: "Idea" },
  { value: "research", label: "Research" },
  { value: "spec_amendment", label: "Spec Amendment" },
  { value: "agent_proposal", label: "Agent Proposal" },
  { value: "adr", label: "ADR" },
  { value: "process_improvement", label: "Process" },
  { value: "external_reference", label: "External Link" },
];

interface SubmitFormProps {
  onSubmitted: () => void;
}

export default function SubmitForm({ onSubmitted }: SubmitFormProps) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [contentType, setContentType] = useState("idea");
  const [sourceUrl, setSourceUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(async () => {
    if (!title.trim()) return;
    setSubmitting(true);
    setError(null);

    const isUrl = contentType === "external_reference" || /^https?:\/\//.test(content.trim());

    try {
      const res = await fetch("/api/governance?path=/api/governance/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          contentType,
          sourceFormat: isUrl && !content.trim() ? "url" : "markdown",
          rawContent: content.trim() || null,
          sourceUrl: sourceUrl.trim() || (isUrl ? content.trim() : null),
          submittedBy: "board",
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Failed: ${res.status}`);
      }

      // Reset and close
      setTitle("");
      setContent("");
      setContentType("idea");
      setSourceUrl("");
      setOpen(false);
      onSubmitted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submission failed");
    } finally {
      setSubmitting(false);
    }
  }, [title, content, contentType, sourceUrl, onSubmitted]);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="px-4 py-2 text-sm bg-accent-bright/20 text-accent-bright rounded-lg hover:bg-accent-bright/30 transition-colors border border-accent-bright/30"
      >
        + New Submission
      </button>
    );
  }

  return (
    <div className="p-4 bg-zinc-800/50 rounded-lg border border-white/10 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-zinc-200">New Governance Submission</h3>
        <button
          onClick={() => setOpen(false)}
          className="text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          &times;
        </button>
      </div>

      {/* Content type selector */}
      <div className="flex flex-wrap gap-1.5">
        {CONTENT_TYPES.map((ct) => (
          <button
            key={ct.value}
            onClick={() => setContentType(ct.value)}
            className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
              contentType === ct.value
                ? "bg-accent-bright/20 text-accent-bright border-accent-bright/30"
                : "bg-white/[0.03] text-zinc-500 border-white/5 hover:bg-white/[0.06]"
            }`}
          >
            {ct.label}
          </button>
        ))}
      </div>

      {/* Title */}
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title (required)"
        className="w-full px-3 py-2 text-sm bg-zinc-800 border border-white/10 rounded-lg text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-accent/50"
      />

      {/* URL field for external references */}
      {(contentType === "external_reference" || contentType === "research") && (
        <input
          type="url"
          value={sourceUrl}
          onChange={(e) => setSourceUrl(e.target.value)}
          placeholder="URL (optional)"
          className="w-full px-3 py-2 text-sm bg-zinc-800 border border-white/10 rounded-lg text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-accent/50"
        />
      )}

      {/* Content */}
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="Description, markdown content, or paste a URL..."
        rows={4}
        className="w-full px-3 py-2 text-sm bg-zinc-800 border border-white/10 rounded-lg text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-accent/50 resize-none"
      />

      {error && (
        <div className="text-xs text-red-400">{error}</div>
      )}

      <div className="flex gap-2 justify-end">
        <button
          onClick={() => setOpen(false)}
          className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={submitting || !title.trim()}
          className="px-4 py-2 text-sm bg-accent-bright/20 text-accent-bright rounded-lg hover:bg-accent-bright/30 transition-colors disabled:opacity-40"
        >
          {submitting ? "Submitting..." : "Submit for Audit"}
        </button>
      </div>
    </div>
  );
}
