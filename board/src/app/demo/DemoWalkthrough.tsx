"use client";

import { useState } from "react";
import IntelligenceBar from "@/components/inbox/IntelligenceBar";
import WhyThisDraft from "@/components/inbox/WhyThisDraft";
import GroundedInPanel from "@/components/inbox/GroundedInPanel";
import PipelineReplay from "@/components/inbox/PipelineReplay";
import ThreadView from "@/components/inbox/ThreadView";
import DraftCompose from "@/components/inbox/DraftCompose";
import ToneMatchPill from "@/components/inbox/ToneMatchPill";
import ActionBar from "@/components/inbox/ActionBar";
import {
  DEMO_DRAFT,
  DEMO_EMAIL_BODY,
  DEMO_KB_CHUNKS,
  DEMO_PIPELINE_TIMELINE,
} from "./demo-fixtures";

/**
 * Stakeholder demo: static fixtures only. No inbox-proxy, search, email, or pipeline API calls.
 */
export default function DemoWalkthrough() {
  const draft = DEMO_DRAFT;
  const email = draft.emails;
  const [isEditing] = useState(false);

  return (
    <div className="max-w-4xl mx-auto w-full min-h-full flex flex-col">
      <div className="shrink-0 px-4 py-3 border-b border-amber-500/25 bg-amber-500/10">
        <div className="flex items-start gap-3">
          <span className="text-amber-400 shrink-0 mt-0.5" aria-hidden>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A2 2 0 0122 9.528v4.944a2 2 0 01-1.447 1.804L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          </span>
          <div>
            <h1 className="text-sm font-semibold text-amber-100">Product demo</h1>
            <p className="text-xs text-amber-200/80 mt-1 leading-relaxed">
              Everything in this view is synthetic. No messages, drafts, or knowledge base queries are
              sent to your inbox or production APIs. Actions are disabled.
            </p>
          </div>
        </div>
      </div>

      <div className="flex-1 flex flex-col border border-white/5 rounded-lg overflow-hidden bg-surface-DEFAULT mt-4 mx-4 mb-6">
        <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between gap-2 shrink-0">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
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
            demoMode
            onApproveAndSend={() => {}}
            onApproveOnly={() => {}}
            onEdit={() => {}}
            onReject={() => {}}
            submitting={false}
          />
        </div>

        <IntelligenceBar draft={draft} />
        <WhyThisDraft draft={draft} />
        <GroundedInPanel draft={draft} demoChunks={DEMO_KB_CHUNKS} />
        <PipelineReplay messageId={draft.message_id} demoTimeline={DEMO_PIPELINE_TIMELINE} />

        <div className="flex-1 overflow-y-auto min-h-0">
          <ThreadView draft={draft} demoStaticBody={DEMO_EMAIL_BODY} />
          <DraftCompose
            draft={draft}
            isEditing={isEditing}
            onSetEditing={() => {}}
            onSave={() => {}}
            onCancel={() => {}}
            submitting={false}
            readOnly
          />
        </div>
      </div>
    </div>
  );
}
