"use client";

import { useState } from "react";
import { markdownToHtml } from "@/lib/markdown";

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
}

export default function MarkdownEditor({ value, onChange, placeholder, rows = 5 }: MarkdownEditorProps) {
  const [tab, setTab] = useState<"write" | "preview">("write");

  return (
    <div className="border border-white/10 rounded-lg overflow-hidden bg-zinc-800">
      <div className="flex border-b border-white/10">
        <button
          type="button"
          onClick={() => setTab("write")}
          className={`px-3 py-1.5 text-xs font-medium transition-colors ${
            tab === "write"
              ? "text-zinc-200 bg-zinc-700"
              : "text-zinc-500 hover:text-zinc-300"
          }`}
        >
          Write
        </button>
        <button
          type="button"
          onClick={() => setTab("preview")}
          className={`px-3 py-1.5 text-xs font-medium transition-colors ${
            tab === "preview"
              ? "text-zinc-200 bg-zinc-700"
              : "text-zinc-500 hover:text-zinc-300"
          }`}
        >
          Preview
        </button>
      </div>
      {tab === "write" ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={rows}
          className="w-full bg-transparent px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none font-mono resize-y"
        />
      ) : (
        <div
          className="px-3 py-2 prose prose-sm prose-invert max-w-none min-h-[80px]"
          dangerouslySetInnerHTML={{ __html: markdownToHtml(value || "*Nothing to preview*") }}
        />
      )}
    </div>
  );
}
