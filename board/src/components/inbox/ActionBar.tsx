"use client";

import { useState, useRef, useEffect } from "react";

// ---------------------------------------------------------------------------
// ActionBar — Sticky action buttons in DetailHeader
// ---------------------------------------------------------------------------

export default function ActionBar({
  onApproveAndSend,
  onApproveOnly,
  onEdit,
  onReject,
  submitting,
  demoMode,
}: {
  onApproveAndSend: () => void;
  onApproveOnly: () => void;
  onEdit: () => void;
  onReject: () => void;
  submitting: boolean;
  /** Disables all actions — stakeholder demo (no sends / approvals). */
  demoMode?: boolean;
}) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return;
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [dropdownOpen]);

  return (
    <div className="flex items-center gap-2">
      {/* Primary: Approve & Send with dropdown */}
      <div className="relative" ref={dropdownRef}>
        <div className="flex items-stretch">
          <button
            onClick={onApproveAndSend}
            disabled={submitting || demoMode}
            title={demoMode ? "Demo only — actions disabled" : undefined}
            className="bg-emerald-600 hover:bg-emerald-500 text-white font-medium px-4 py-2 rounded-l-lg
                     transition-colors disabled:opacity-50 text-sm"
          >
            {submitting ? "Sending..." : "Approve & Send"}
          </button>
          <button
            onClick={() => setDropdownOpen(!dropdownOpen)}
            disabled={submitting || demoMode}
            title={demoMode ? "Demo only" : undefined}
            className="bg-emerald-600 hover:bg-emerald-500 text-white px-2 rounded-r-lg
                     border-l border-emerald-500/50 transition-colors disabled:opacity-50 flex items-center"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M4 5.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>

        {/* Dropdown */}
        {dropdownOpen && !demoMode && (
          <div className="absolute top-full right-0 mt-1 bg-surface-overlay border border-white/10 rounded-lg shadow-xl shadow-black/40 py-1 z-10 min-w-[160px]">
            <button
              onClick={() => {
                onApproveOnly();
                setDropdownOpen(false);
              }}
              className="w-full text-left px-3 py-1.5 text-sm text-zinc-300 hover:bg-white/5 transition-colors"
            >
              Approve only
            </button>
            <button
              onClick={() => {
                onApproveAndSend();
                setDropdownOpen(false);
              }}
              className="w-full text-left px-3 py-1.5 text-sm text-zinc-300 hover:bg-white/5 transition-colors"
            >
              Send immediately
            </button>
          </div>
        )}
      </div>

      {/* Secondary: Edit */}
      <button
        onClick={onEdit}
        disabled={demoMode}
        title={demoMode ? "Demo only — actions disabled" : undefined}
        className="text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded-lg px-4 py-2 text-sm transition-colors disabled:opacity-50"
      >
        Edit
      </button>

      {/* Tertiary: Reject */}
      <button
        onClick={onReject}
        disabled={submitting || demoMode}
        title={demoMode ? "Demo only — actions disabled" : undefined}
        className="text-red-400 hover:bg-red-500/10 rounded-lg px-4 py-2 text-sm transition-colors disabled:opacity-50"
      >
        Reject
      </button>
    </div>
  );
}
