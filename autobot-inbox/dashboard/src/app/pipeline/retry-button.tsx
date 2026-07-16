"use client";

import { useState } from "react";
import { apiPost } from "@/lib/api";

export function RetryButton({ id, title }: { id: string; title: string }) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");

  async function handleRetry() {
    setState("loading");
    try {
      await apiPost("/api/pipeline/stuck/retry", { id });
      setState("done");
    } catch {
      setState("error");
      setTimeout(() => setState("idle"), 2000);
    }
  }

  if (state === "done") {
    return <span className="text-xs text-green-400">queued</span>;
  }

  return (
    <button
      onClick={handleRetry}
      disabled={state === "loading"}
      className="px-2 py-0.5 rounded text-xs bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30 transition-colors disabled:opacity-50"
    >
      {state === "loading" ? "..." : state === "error" ? "failed" : "retry"}
    </button>
  );
}
