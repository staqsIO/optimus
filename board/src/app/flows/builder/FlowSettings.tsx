"use client";

import type { FlowBuilderState, BuilderAction } from "./types";

export default function FlowSettings({
  state,
  dispatch,
}: {
  state: FlowBuilderState;
  dispatch: React.Dispatch<BuilderAction>;
}) {
  return (
    <div className="space-y-3">
      {/* Name */}
      <div>
        <label className="text-[10px] text-zinc-500 uppercase tracking-widest mb-1 block">Flow Name *</label>
        <input
          type="text"
          placeholder="e.g. email-to-draft-pipeline"
          value={state.name}
          onChange={(e) => dispatch({ type: "SET_NAME", name: e.target.value })}
          className="w-full px-3 py-1.5 text-xs bg-white/[0.04] border border-white/10 rounded text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-accent/50"
        />
      </div>

      {/* Description */}
      <div>
        <label className="text-[10px] text-zinc-500 uppercase tracking-widest mb-1 block">Description</label>
        <textarea
          placeholder="What does this flow do?"
          value={state.description}
          onChange={(e) => dispatch({ type: "SET_DESCRIPTION", description: e.target.value })}
          rows={2}
          className="w-full px-3 py-1.5 text-xs bg-white/[0.04] border border-white/10 rounded text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-accent/50 resize-none"
        />
      </div>

      {/* Max Depth / Timeout / Retry */}
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="text-[10px] text-zinc-500 uppercase tracking-widest mb-1 block">Max Depth</label>
          <input
            type="number"
            min={1}
            max={32}
            value={state.maxDepth}
            onChange={(e) => dispatch({ type: "SET_MAX_DEPTH", value: parseInt(e.target.value) || 8 })}
            className="w-full px-3 py-1.5 text-xs bg-white/[0.04] border border-white/10 rounded text-zinc-200 focus:outline-none focus:border-accent/50 font-mono"
          />
        </div>

        <div>
          <label className="text-[10px] text-zinc-500 uppercase tracking-widest mb-1 block">Timeout</label>
          <select
            value={state.timeoutMs}
            onChange={(e) => dispatch({ type: "SET_TIMEOUT", value: parseInt(e.target.value) })}
            className="w-full px-3 py-1.5 text-xs bg-white/[0.04] border border-white/10 rounded text-zinc-200 focus:outline-none focus:border-accent/50"
          >
            <option value={10000}>10s</option>
            <option value={30000}>30s</option>
            <option value={60000}>60s</option>
            <option value={120000}>2m</option>
            <option value={300000}>5m</option>
          </select>
        </div>

        <div>
          <label className="text-[10px] text-zinc-500 uppercase tracking-widest mb-1 block">On Failure</label>
          <select
            value={state.retryPolicy.strategy}
            onChange={(e) =>
              dispatch({
                type: "SET_RETRY",
                strategy: e.target.value as FlowBuilderState["retryPolicy"]["strategy"],
                max_retries: state.retryPolicy.max_retries,
              })
            }
            className="w-full px-3 py-1.5 text-xs bg-white/[0.04] border border-white/10 rounded text-zinc-200 focus:outline-none focus:border-accent/50"
          >
            <option value="none">Stop flow</option>
            <option value="skip">Skip failed step</option>
            <option value="retry_step">Retry step</option>
          </select>
        </div>
      </div>

      {/* Retry count (only if retry_step) */}
      {state.retryPolicy.strategy === "retry_step" && (
        <div className="w-32">
          <label className="text-[10px] text-zinc-500 uppercase tracking-widest mb-1 block">Max Retries</label>
          <input
            type="number"
            min={1}
            max={10}
            value={state.retryPolicy.max_retries}
            onChange={(e) =>
              dispatch({
                type: "SET_RETRY",
                strategy: "retry_step",
                max_retries: parseInt(e.target.value) || 3,
              })
            }
            className="w-full px-3 py-1.5 text-xs bg-white/[0.04] border border-white/10 rounded text-zinc-200 focus:outline-none focus:border-accent/50 font-mono"
          />
        </div>
      )}
    </div>
  );
}
