"use client";

import { useState, useCallback } from "react";
import { useSession } from "next-auth/react";
import { type Draft } from "./QueueItem";
import IntelligenceBar from "./IntelligenceBar";
import WhyThisDraft from "./WhyThisDraft";
import GroundedInPanel from "./GroundedInPanel";
import ActionBar from "./ActionBar";
import ThreadView from "./ThreadView";
import DraftCompose from "./DraftCompose";
import ToneMatchPill from "./ToneMatchPill";
import PipelineReplay from "./PipelineReplay";

// ---------------------------------------------------------------------------
// DetailPanel — Right column container
// ---------------------------------------------------------------------------

export default function DetailPanel({
  draft,
  isEditing,
  onSetEditing,
  onAction,
  onClose,
}: {
  draft: Draft | null;
  isEditing: boolean;
  onSetEditing: (editing: boolean) => void;
  onAction: () => void;
  onClose: () => void;
}) {
  const { data: session } = useSession();
  const [submitting, setSubmitting] = useState(false);

  const actedBy =
    (session?.user as Record<string, unknown>)?.login as string ||
    session?.user?.name ||
    null;

  const handleAction = useCallback(
    async (action: "approve" | "reject" | "send") => {
      if (!draft) return;
      setSubmitting(true);
      try {
        const endpoint =
          action === "send" ? "/api/drafts/send" : `/api/drafts/${action}`;
        await fetch("/api/inbox-proxy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path: endpoint,
            body: { id: draft.id, acted_by: actedBy },
          }),
        });
        onAction();
      } finally {
        setSubmitting(false);
      }
    },
    [draft, actedBy, onAction],
  );

  const handleEdit = useCallback(
    async (editedBody: string) => {
      if (!draft) return;
      setSubmitting(true);
      try {
        await fetch("/api/inbox-proxy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path: "/api/drafts/edit",
            body: { id: draft.id, editedBody },
          }),
        });
        onSetEditing(false);
        onAction();
      } finally {
        setSubmitting(false);
      }
    },
    [draft, onAction, onSetEditing],
  );

  // Empty state
  if (!draft) {
    return (
      <div className="flex-1 flex items-center justify-center max-md:hidden">
        <div className="text-center">
          <div className="text-zinc-600 mb-2">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mx-auto">
              <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <p className="text-sm text-zinc-500">Select a draft to review</p>
          <p className="text-xs text-zinc-600 mt-1">
            Use <kbd className="px-1 py-0.5 rounded bg-surface-overlay border border-white/5 text-zinc-500 font-mono text-[10px]">j</kbd> / <kbd className="px-1 py-0.5 rounded bg-surface-overlay border border-white/5 text-zinc-500 font-mono text-[10px]">k</kbd> to navigate, <kbd className="px-1 py-0.5 rounded bg-surface-overlay border border-white/5 text-zinc-500 font-mono text-[10px]">Enter</kbd> to open
          </p>
        </div>
      </div>
    );
  }

  const email = draft.emails;

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden max-md:fixed max-md:inset-0 max-md:z-40 max-md:bg-surface-DEFAULT">
      {/* Detail Header */}
      <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between shrink-0 gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            {/* Mobile back button */}
            <button
              onClick={onClose}
              className="md:hidden text-zinc-400 hover:text-zinc-200 transition-colors -ml-1 mr-1"
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M12 4l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <span className="text-sm font-medium text-zinc-200 truncate">
              {email.from_name || email.from_address}
            </span>
            <span className="text-xs text-zinc-500 shrink-0">
              Re: {email.subject || "(no subject)"}
            </span>
          </div>
          <div className="mt-1.5 flex items-center gap-2 flex-wrap">
            <ToneMatchPill toneScore={draft.tone_score} />
          </div>
        </div>
        <ActionBar
          onApproveAndSend={() => handleAction("send")}
          onApproveOnly={() => handleAction("approve")}
          onEdit={() => onSetEditing(true)}
          onReject={() => handleAction("reject")}
          submitting={submitting}
        />
      </div>

      {/* IntelligenceBar — always visible */}
      <IntelligenceBar draft={draft} />

      <WhyThisDraft draft={draft} />
      <GroundedInPanel draft={draft} />
      <PipelineReplay messageId={draft.message_id} />

      {/* Scrollable content area */}
      <div className="flex-1 overflow-y-auto">
        {/* ThreadView — parent message */}
        <ThreadView draft={draft} />

        {/* DraftCompose — inline editable draft */}
        <DraftCompose
          draft={draft}
          isEditing={isEditing}
          onSetEditing={onSetEditing}
          onSave={handleEdit}
          onCancel={() => onSetEditing(false)}
          submitting={submitting}
        />
      </div>

      {/* Mobile sticky action bar */}
      <div className="md:hidden border-t border-white/5 px-4 py-3 bg-surface-DEFAULT shrink-0">
        <ActionBar
          onApproveAndSend={() => handleAction("send")}
          onApproveOnly={() => handleAction("approve")}
          onEdit={() => onSetEditing(true)}
          onReject={() => handleAction("reject")}
          submitting={submitting}
        />
      </div>
    </div>
  );
}
