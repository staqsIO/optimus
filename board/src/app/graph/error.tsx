"use client";

export default function GraphError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex items-center justify-center h-[calc(100vh-49px)]">
      <div className="text-center max-w-md">
        <div className="text-sm text-red-400 mb-2">Graph failed to load</div>
        <div className="text-xs text-zinc-500 mb-4 font-mono bg-zinc-900 rounded p-3 text-left">
          {error.message || "Unknown error"}
        </div>
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
