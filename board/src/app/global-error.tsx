"use client";

import { useEffect, useState } from "react";
import { isChunkLoadError, recoverFromChunkError } from "@/lib/chunk-recovery";

/**
 * Top-level boundary (STAQPRO-544). Catches errors that escape the route-level
 * `error.tsx` — including chunk-load failures while loading the root layout's own
 * chunks after a mid-session deploy. Must render its own <html>/<body>.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [recovering] = useState(() => recoverFromChunkError(error));

  useEffect(() => {
    if (!recovering) recoverFromChunkError(error);
  }, [error, recovering]);

  const isChunk = recovering || isChunkLoadError(error);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0a0a0f",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
        }}
      >
        <div style={{ textAlign: "center", maxWidth: "28rem", padding: "1rem" }}>
          {isChunk ? (
            <>
              <div style={{ fontSize: "0.875rem", color: "#818cf8", marginBottom: "0.5rem" }}>
                Updating to the latest version…
              </div>
              <div style={{ fontSize: "0.75rem", color: "#71717a" }}>
                Reloading the app.
              </div>
            </>
          ) : (
            <>
              <div style={{ fontSize: "0.875rem", color: "#f87171", marginBottom: "0.75rem" }}>
                Something went wrong
              </div>
              <div
                style={{
                  fontSize: "0.75rem",
                  color: "#a1a1aa",
                  marginBottom: "1rem",
                  fontFamily: "ui-monospace, monospace",
                  background: "#18181b",
                  borderRadius: "0.375rem",
                  padding: "0.75rem",
                  textAlign: "left",
                }}
              >
                {error.message || "Unknown error"}
              </div>
              <button
                onClick={reset}
                style={{
                  padding: "0.5rem 1rem",
                  fontSize: "0.75rem",
                  background: "rgba(99,102,241,0.2)",
                  color: "#818cf8",
                  border: "none",
                  borderRadius: "0.375rem",
                  cursor: "pointer",
                }}
              >
                Try again
              </button>
            </>
          )}
        </div>
      </body>
    </html>
  );
}
