"use client";

/**
 * DuplicatesDrawer — OPT-81 UI: review/merge/dismiss duplicate contact groups.
 *
 * Opens as a right-side panel over the contacts list. Each candidate pair shows
 * both contacts (name, email, tier, engagement counts) and allows the board
 * member to:
 *   - MERGE: pick canonical → call POST /api/contacts/merge (hard merge, irreversible,
 *     for manual board-reviewed pairs) OR POST /api/contacts/auto-merge (dryRun=false,
 *     scored soft-merge pass). The drawer uses the explicit board-reviewed merge
 *     path (POST /api/contacts/merge with primaryId=canonical, secondaryId=other).
 *   - DISMISS: remove the pair from the review queue locally (no backend write).
 *
 * Unmerge is handled on the individual contact detail page (see contacts/[id]/page.tsx).
 */

import { useState, useCallback } from "react";
import { opsPost } from "@/lib/ops-api";

export interface DuplicatePair {
  id_a: string;
  name_a: string | null;
  email_a: string | null;
  tier_a?: string | null;
  emails_received_a?: number;
  emails_sent_a?: number;
  id_b: string;
  name_b: string | null;
  email_b: string | null;
  tier_b?: string | null;
  emails_received_b?: number;
  emails_sent_b?: number;
  name_sim: number;
  match_reason?: string | null;
}

interface DuplicatesDrawerProps {
  open: boolean;
  pairs: DuplicatePair[];
  onClose: () => void;
  onPairsChange: (pairs: DuplicatePair[]) => void;
  onContactsRefresh: () => void;
}

const TIER_COLORS: Record<string, string> = {
  inner_circle: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  active: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  inactive: "bg-zinc-700/30 text-zinc-500 border-zinc-700/40",
  inbound_only: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
  newsletter: "bg-violet-500/10 text-violet-400 border-violet-500/20",
  automated: "bg-orange-500/10 text-orange-400 border-orange-500/20",
  unknown: "bg-zinc-500/10 text-zinc-500 border-zinc-500/20",
};

const MATCH_REASON_LABELS: Record<string, string> = {
  strong_name: "name match",
  shared_org: "same org",
  shared_domain: "shared domain",
};

function MatchBadge({ reason, sim }: { reason?: string | null; sim: number }) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {reason && MATCH_REASON_LABELS[reason] && (
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
          {MATCH_REASON_LABELS[reason]}
        </span>
      )}
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 tabular-nums">
        {Math.round(sim * 100)}% match
      </span>
    </div>
  );
}

function ContactCard({
  id,
  name,
  email,
  tier,
  emailsReceived,
  emailsSent,
  isCanonical,
  onSetCanonical,
}: {
  id: string;
  name: string | null;
  email: string | null;
  tier?: string | null;
  emailsReceived?: number;
  emailsSent?: number;
  isCanonical: boolean;
  onSetCanonical: (id: string) => void;
}) {
  const tierClass = TIER_COLORS[tier ?? "unknown"] ?? TIER_COLORS.unknown;
  return (
    <button
      type="button"
      onClick={() => onSetCanonical(id)}
      className={`w-full text-left rounded-lg border px-4 py-3 transition-colors ${
        isCanonical
          ? "border-blue-500/40 bg-blue-500/5 ring-1 ring-blue-500/30"
          : "border-white/10 bg-zinc-900 hover:border-white/20"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-zinc-100 truncate">
              {name || "Unnamed Contact"}
            </span>
            {tier && (
              <span className={`text-[10px] px-1.5 py-px rounded-full border ${tierClass}`}>
                {tier.replace("_", " ")}
              </span>
            )}
            {isCanonical && (
              <span className="text-[10px] px-1.5 py-px rounded bg-blue-500/10 text-blue-400 border border-blue-500/20 font-semibold">
                canonical
              </span>
            )}
          </div>
          {email && (
            <div className="text-xs text-zinc-500 mt-0.5 truncate">{email}</div>
          )}
          {(emailsReceived != null || emailsSent != null) && (
            <div className="flex items-center gap-3 mt-1.5 text-[10px] text-zinc-600">
              {emailsReceived != null && (
                <span>{emailsReceived} received</span>
              )}
              {emailsSent != null && (
                <span>{emailsSent} sent</span>
              )}
            </div>
          )}
        </div>
        <div
          className={`mt-0.5 w-4 h-4 rounded-full border-2 flex-shrink-0 transition-colors ${
            isCanonical
              ? "border-blue-400 bg-blue-500"
              : "border-zinc-600 bg-transparent"
          }`}
        />
      </div>
    </button>
  );
}

interface PairCardProps {
  pair: DuplicatePair;
  onMerge: (pair: DuplicatePair, canonicalId: string) => Promise<void>;
  onDismiss: (pair: DuplicatePair) => void;
  merging: boolean;
}

function PairCard({ pair, onMerge, onDismiss, merging }: PairCardProps) {
  const [canonical, setCanonical] = useState<string>(pair.id_a);
  const [error, setError] = useState<string | null>(null);

  const handleMerge = async () => {
    setError(null);
    await onMerge(pair, canonical);
  };

  return (
    <div className="rounded-xl border border-amber-500/20 bg-zinc-950 overflow-hidden">
      <div className="px-4 py-3 border-b border-amber-500/10 flex items-center justify-between gap-2">
        <MatchBadge reason={pair.match_reason} sim={pair.name_sim} />
        <button
          type="button"
          onClick={() => onDismiss(pair)}
          className="text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors px-1.5 py-0.5"
        >
          dismiss
        </button>
      </div>

      <div className="p-4 space-y-2">
        <p className="text-[10px] text-zinc-600 mb-2 select-none">
          Click the person to keep as canonical — the other will be merged into it.
        </p>
        <ContactCard
          id={pair.id_a}
          name={pair.name_a}
          email={pair.email_a}
          tier={pair.tier_a}
          emailsReceived={pair.emails_received_a}
          emailsSent={pair.emails_sent_a}
          isCanonical={canonical === pair.id_a}
          onSetCanonical={setCanonical}
        />
        <ContactCard
          id={pair.id_b}
          name={pair.name_b}
          email={pair.email_b}
          tier={pair.tier_b}
          emailsReceived={pair.emails_received_b}
          emailsSent={pair.emails_sent_b}
          isCanonical={canonical === pair.id_b}
          onSetCanonical={setCanonical}
        />
      </div>

      {error && (
        <div className="px-4 pb-3 text-xs text-red-400">{error}</div>
      )}

      <div className="px-4 pb-4">
        <button
          type="button"
          onClick={handleMerge}
          disabled={merging}
          className="w-full py-2 text-xs rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/20 hover:bg-amber-500/20 transition-colors disabled:opacity-50 font-medium"
        >
          {merging ? "Merging…" : "Merge into canonical"}
        </button>
      </div>
    </div>
  );
}

export default function DuplicatesDrawer({
  open,
  pairs,
  onClose,
  onPairsChange,
  onContactsRefresh,
}: DuplicatesDrawerProps) {
  const [mergingKey, setMergingKey] = useState<string | null>(null);
  const [successCount, setSuccessCount] = useState(0);
  const [mergeError, setMergeError] = useState<string | null>(null);

  const handleMerge = useCallback(
    async (pair: DuplicatePair, canonicalId: string) => {
      const secondaryId = canonicalId === pair.id_a ? pair.id_b : pair.id_a;
      const key = `${pair.id_a}-${pair.id_b}`;
      setMergingKey(key);
      setMergeError(null);
      try {
        const result = await opsPost<{ merged?: boolean; error?: string }>(
          "/api/contacts/merge",
          { primaryId: canonicalId, secondaryId, reason: "board-reviewed duplicate" }
        );
        if (result.ok) {
          onPairsChange(pairs.filter((p) => !(p.id_a === pair.id_a && p.id_b === pair.id_b)));
          setSuccessCount((c) => c + 1);
          await onContactsRefresh();
        } else {
          setMergeError(result.error ?? "Merge failed");
        }
      } finally {
        setMergingKey(null);
      }
    },
    [pairs, onPairsChange, onContactsRefresh]
  );

  const handleDismiss = useCallback(
    (pair: DuplicatePair) => {
      onPairsChange(pairs.filter((p) => !(p.id_a === pair.id_a && p.id_b === pair.id_b)));
    },
    [pairs, onPairsChange]
  );

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 z-40"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Drawer */}
      <div
        role="dialog"
        aria-label="Review duplicate contacts"
        className="fixed right-0 top-0 h-full w-full max-w-md bg-zinc-950 border-l border-white/10 z-50 flex flex-col shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10 flex-shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">
              Review Duplicates
            </h2>
            <p className="text-xs text-zinc-500 mt-0.5">
              {pairs.length > 0
                ? `${pairs.length} pair${pairs.length !== 1 ? "s" : ""} to review`
                : "All pairs resolved"}
              {successCount > 0 && (
                <span className="ml-2 text-emerald-400">{successCount} merged</span>
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors"
            aria-label="Close"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {mergeError && (
            <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-xs text-red-400">
              {mergeError}
            </div>
          )}

          {pairs.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-center">
              <div className="text-2xl mb-2">✓</div>
              <div className="text-sm text-zinc-300 font-medium">All pairs resolved</div>
              <div className="text-xs text-zinc-600 mt-1">
                {successCount > 0
                  ? `${successCount} merge${successCount !== 1 ? "s" : ""} completed`
                  : "No duplicate pairs remaining"}
              </div>
            </div>
          ) : (
            pairs.map((pair) => {
              const key = `${pair.id_a}-${pair.id_b}`;
              return (
                <PairCard
                  key={key}
                  pair={pair}
                  onMerge={handleMerge}
                  onDismiss={handleDismiss}
                  merging={mergingKey === key}
                />
              );
            })
          )}
        </div>

        {/* Footer */}
        {pairs.length > 0 && (
          <div className="px-4 py-3 border-t border-white/10 flex-shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="w-full py-2 text-xs rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors border border-white/10"
            >
              Done reviewing
            </button>
          </div>
        )}
      </div>
    </>
  );
}
