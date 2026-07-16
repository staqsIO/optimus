"use client";

import { useEffect, useState } from "react";
import { isChunkLoadError, recoverFromChunkError } from "@/lib/chunk-recovery";

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // On a stale-chunk failure (build skew after a mid-session deploy), reload once.
  const [recovering] = useState(() => recoverFromChunkError(error));

  useEffect(() => {
    // Defensive: if state init ran before `window` existed, retry recovery on mount.
    if (!recovering) recoverFromChunkError(error);
  }, [error, recovering]);

  if (recovering || isChunkLoadError(error)) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#0a0a0f]">
        <div className="text-center max-w-md">
          <div className="text-sm text-indigo-400 mb-2">
            Updating to the latest version…
          </div>
          <div className="text-xs text-zinc-500">Reloading this page.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center h-screen bg-[#0a0a0f]">
      <div className="text-center max-w-md">
        <div className="text-sm text-red-400 mb-2">Something went wrong</div>
        <div className="text-xs text-zinc-500 mb-4 font-mono bg-zinc-900 rounded p-3 text-left">
          {error.message || "Unknown error"}
        </div>
        <button
          onClick={reset}
          className="px-4 py-2 text-xs bg-indigo-500/20 text-indigo-400 rounded hover:bg-indigo-500/30 transition-colors"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
