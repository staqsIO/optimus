"use client";

import { useEffect } from "react";

export default function WorkstationError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log full error details to console for debugging
    console.error("[WorkstationError] Full error:", error);
    console.error("[WorkstationError] Stack:", error.stack);
    console.error("[WorkstationError] Digest:", error.digest);
  }, [error]);

  return (
    <div className="flex items-center justify-center h-[calc(100vh-49px)]">
      <div className="text-center max-w-lg">
        <div className="text-sm text-red-400 mb-2">Workstation failed to load</div>
        <div className="text-xs text-zinc-500 mb-2 font-mono bg-zinc-900 rounded p-3 text-left whitespace-pre-wrap max-h-40 overflow-y-auto">
          {error.message || "Unknown error"}
        </div>
        {error.stack && (
          <details className="mb-4 text-left">
            <summary className="text-[10px] text-zinc-600 cursor-pointer hover:text-zinc-400">Show stack trace</summary>
            <div className="text-[9px] text-zinc-600 font-mono bg-zinc-900 rounded p-2 mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap">
              {error.stack}
            </div>
          </details>
        )}
        <button
          onClick={reset}
          className="px-4 py-2 text-xs bg-accent-bright/20 text-accent-bright rounded hover:bg-accent-bright/30 transition-colors"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
