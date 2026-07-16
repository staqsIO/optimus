"use client";

import { useState, useRef, useEffect } from "react";
import { opsPost } from "@/lib/ops-api";

interface ContractAIBarProps {
  contractId: string;
  onApplyEdit: (newBody: string) => void;
  onUndo: () => void;
  onVersionChanged?: () => void;
}

interface EditResponse {
  newBody: string | null;
  summary: string;
  costUsd: number;
  model: string;
  rejected?: boolean;
  versionId?: string;
  versionNumber?: number;
}

export default function ContractAIBar({ contractId, onApplyEdit, onUndo, onVersionChanged }: ContractAIBarProps) {
  const [instruction, setInstruction] = useState("");
  const [sending, setSending] = useState(false);
  const [lastResult, setLastResult] = useState<{ summary: string; costUsd: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  }, [instruction]);

  // Listen for bracket clicks from the editor — pre-fill + focus. For typed
  // variables ([TYPE:name]), the pre-fill hints at the expected format so the
  // operator writes a well-shaped instruction the first time.
  useEffect(() => {
    function handler(e: Event) {
      const detail = (e as CustomEvent<{ name: string }>).detail;
      if (!detail?.name) return;
      const raw = detail.name;
      const typeMatch = raw.match(/^([A-Z]+):(.+)$/);
      const type = typeMatch ? typeMatch[1] : null;
      const varName = typeMatch ? typeMatch[2] : raw;
      const readable = varName.toLowerCase().replace(/_/g, " ");
      const typeHint =
        type === "DATE"     ? " (a date — YYYY-MM-DD or natural language like 'first Monday of May')" :
        type === "CURRENCY" ? " (an amount in USD — '8500' or '$8,500/mo')" :
        type === "SIGNER"   ? " (full legal name + title)" :
        type === "TEXT"     ? ""
                            : "";
      const prefill = `Fill [${raw}] with${typeHint}: `;
      setInstruction(prefill);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(prefill.length, prefill.length);
        el.setAttribute("data-last-bracket", readable);
      });
    }
    document.addEventListener("bracket-click", handler);
    return () => document.removeEventListener("bracket-click", handler);
  }, []);

  async function submit() {
    const trimmed = instruction.trim();
    if (!trimmed || sending) return;

    setSending(true);
    setError(null);
    try {
      const result = await opsPost<EditResponse>(
        `/api/contracts/${contractId}/edit`,
        { instruction: trimmed }
      );
      if (result.ok) {
        if (result.data.rejected || !result.data.newBody) {
          // LLM couldn't produce a valid contract — show the reason, don't touch the doc
          setError(result.data.summary || "AI couldn't apply the edit — try a more specific instruction");
          setLastResult({ summary: `⚠ ${result.data.summary}`, costUsd: result.data.costUsd });
        } else {
          onApplyEdit(result.data.newBody);
          setLastResult({ summary: result.data.summary, costUsd: result.data.costUsd });
          setInstruction("");
          onVersionChanged?.();
        }
      } else {
        const errMsg = result.error || "Edit failed";
        setError(errMsg.includes("<html") || errMsg.includes("<!DOCTYPE") ? "Backend error — try again" : errMsg);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Don't show raw HTML error pages — extract just the meaningful part
      setError(msg.includes("<html") || msg.includes("<!DOCTYPE") ? "Backend error — try again" : msg);
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function handleUndo() {
    onUndo();
    setLastResult(null);
  }

  return (
    <div className="border-t border-zinc-800 bg-zinc-950/60 px-3 py-2.5">
      {/* Last result row */}
      {lastResult && !sending && (
        <div className="mb-2 flex items-center gap-2 text-[10px]">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">
            <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            {lastResult.summary}
          </span>
          <span className="text-zinc-500">${lastResult.costUsd.toFixed(4)}</span>
          <button
            onClick={handleUndo}
            className="text-zinc-500 hover:text-zinc-300 transition-colors underline-offset-2 hover:underline"
          >
            Undo
          </button>
        </div>
      )}

      {/* Error row */}
      {error && !sending && (
        <div className="mb-2 text-[10px] text-red-400 max-h-8 overflow-hidden truncate">
          {(error.includes("<html") || error.includes("<!DOCTYPE")) ? "Backend error — try again" : error.slice(0, 200)}
        </div>
      )}

      {/* Input row */}
      <div className="flex items-end gap-2">
        <div className="flex-1 relative">
          <textarea
            ref={textareaRef}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Tell AI what to change… (e.g., “Set pricing to $8,500/mo for 12 months” or “Add a 30-day termination clause”)"
            rows={1}
            disabled={sending}
            className="w-full resize-none px-3 py-2 text-xs bg-zinc-900 border border-zinc-700 rounded-lg text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-amber-500/50 disabled:opacity-60"
          />
        </div>
        <button
          onClick={submit}
          disabled={sending || !instruction.trim()}
          className="px-3 py-2 text-xs font-medium rounded-lg bg-amber-600 text-white hover:bg-amber-500 disabled:bg-zinc-800 disabled:text-zinc-600 transition-colors shrink-0"
        >
          {sending ? (
            <span className="inline-flex items-center gap-1.5">
              <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
                <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" className="opacity-75" />
              </svg>
              Editing…
            </span>
          ) : (
            "Apply"
          )}
        </button>
      </div>

      {/* Hint row */}
      <div className="mt-1.5 text-[9px] text-zinc-600">
        Enter to apply · Shift+Enter for new line · Brackets like [CLIENT_NAME] are preserved unless you ask to fill them
      </div>
    </div>
  );
}
