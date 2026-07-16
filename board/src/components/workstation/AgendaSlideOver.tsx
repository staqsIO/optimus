"use client";

import { useEffect } from "react";
import AgendaPanel, { DiscussPanel } from "./AgendaPanel";
import { SpecReferencePanel } from "./SpecReferencePanel";
import type {
  AgendaData,
  AgendaItem,
  AgendaAction,
  DiscussMessage,
  SpecContextEntry,
  SpecProjection,
  ProjectionStatus,
  SpecProposal,
  ProposalAction,
} from "./types";

interface AgendaSlideOverProps {
  open: boolean;
  onClose: () => void;
  // Agenda panel props
  agendaData: AgendaData | null;
  agendaLoading: boolean;
  activeItemId: string | null;
  onAction: (action: AgendaAction, item?: AgendaItem) => void;
  onRefresh: () => void;
  onSpecRefClick: (sectionId: string) => void;
  onActiveSpecSections: (sectionIds: string[], context: Record<string, SpecContextEntry[]>) => void;
  // Discuss panel props
  discussOpen: boolean;
  discussItem: AgendaItem | null;
  discussMessages: DiscussMessage[];
  discussLoading: boolean;
  onSendDiscuss: (text: string) => void;
  onCloseDiscuss: () => void;
  // Spec reference panel props
  activeSpecSectionIds: string[];
  activeSpecContext: Record<string, SpecContextEntry[]>;
  projections: Record<string, SpecProjection>;
  projectionStatus: Record<string, ProjectionStatus>;
  projectionCommitMessage: string;
  projectionSourceItemId: string | null;
  onRequestProjection: (sectionId: string) => void;
  onUpdateProjectionEdit: (sectionId: string, editedContent: string) => void;
  onSetProjectionStatus: (sectionId: string, status: ProjectionStatus) => void;
  onSubmitProjections: (excludedSections?: Set<string>) => void;
  onSetProjectionCommitMessage: (msg: string) => void;
  onClearProjections: () => void;
  // Proposal props
  proposals: SpecProposal[];
  onProposalAction: (proposalId: string, action: ProposalAction, feedback?: string) => void;
  proposalActionLoading: boolean;
  // Rework loop
  onReviseProjection?: (sectionId: string, feedback: string) => void;
  // Discuss persistence
  onClearDiscussThread?: (itemId: string) => void;
}

export default function AgendaSlideOver({
  open,
  onClose,
  agendaData,
  agendaLoading,
  activeItemId,
  onAction,
  onRefresh,
  onSpecRefClick,
  onActiveSpecSections,
  discussOpen,
  discussItem,
  discussMessages,
  discussLoading,
  onSendDiscuss,
  onCloseDiscuss,
  activeSpecSectionIds,
  activeSpecContext,
  projections,
  projectionStatus,
  projectionCommitMessage,
  projectionSourceItemId,
  onRequestProjection,
  onUpdateProjectionEdit,
  onSetProjectionStatus,
  onSubmitProjections,
  onSetProjectionCommitMessage,
  onClearProjections,
  proposals,
  onProposalAction,
  proposalActionLoading,
  onReviseProjection,
  onClearDiscussThread,
}: AgendaSlideOverProps) {
  // Lock body scroll when open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      {/* Thin collapse strip on the left — click to close */}
      <div
        className="fixed inset-y-0 left-0 z-40 w-12 bg-black/30 hover:bg-black/50 transition-colors cursor-pointer flex items-center justify-center group"
        onClick={onClose}
        title="Collapse SPEC.md"
      >
        <div className="flex flex-col items-center gap-2 text-zinc-500 group-hover:text-zinc-300 transition-colors">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          <span className="text-[10px] font-medium tracking-wider [writing-mode:vertical-lr] rotate-180">
            COLLAPSE
          </span>
        </div>
      </div>

      {/* Main panel — takes up nearly full width */}
      <div className="fixed inset-y-0 left-12 right-0 z-50 flex">
        <div className="flex w-full bg-zinc-900 border-l border-white/10 shadow-2xl overflow-hidden">
          {/* Agenda panel — left column */}
          <div className="flex-1 min-w-[320px] overflow-y-auto border-r border-white/[0.06]">
            <div className="max-w-3xl mx-auto px-4 sm:px-6 py-5 space-y-5">
              {/* Header */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-amber-500/10 border border-amber-500/20">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-amber-400">
                      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                      <line x1="16" y1="13" x2="8" y2="13" />
                      <line x1="16" y1="17" x2="8" y2="17" />
                      <polyline points="10 9 9 9 8 9" />
                    </svg>
                  </div>
                  <div>
                    <h2 className="text-lg font-semibold text-zinc-100">SPEC.md</h2>
                    <p className="text-xs text-zinc-500">Governance items, spec patches, and projections</p>
                  </div>
                </div>
                <button
                  onClick={onClose}
                  className="p-2 text-zinc-500 hover:text-zinc-300 transition-colors rounded-lg hover:bg-white/[0.04]"
                  aria-label="Close SPEC.md panel"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>

              <AgendaPanel
                data={agendaData}
                loading={agendaLoading}
                activeItemId={activeItemId}
                onAction={onAction}
                onRefresh={onRefresh}
                onSpecRefClick={onSpecRefClick}
                onActiveSpecSections={onActiveSpecSections}
              />
            </div>
          </div>

          {/* Discuss panel — middle */}
          {discussOpen && discussItem && (
            <DiscussPanel
              item={discussItem}
              messages={discussMessages}
              loading={discussLoading}
              onSend={onSendDiscuss}
              onClose={onCloseDiscuss}
              onClearThread={onClearDiscussThread ? () => onClearDiscussThread(discussItem.id) : undefined}
              onSpecRefClick={(id) =>
                onActiveSpecSections([id], {
                  [id]: [{ title: discussItem.title, file: discussItem.source.file }],
                })
              }
            />
          )}

          {/* Spec reference panel — right */}
          {agendaData?.specIndex && (
            <SpecReferencePanel
              specIndex={agendaData.specIndex}
              sections={agendaData.sections}
              activeSpecSectionIds={activeSpecSectionIds}
              activeContext={activeSpecContext}
              narrow={discussOpen}
              projections={projections}
              projectionStatus={projectionStatus}
              projectionCommitMessage={projectionCommitMessage}
              projectionSourceItemId={projectionSourceItemId}
              onRequestProjection={onRequestProjection}
              onUpdateProjectionEdit={onUpdateProjectionEdit}
              onSetProjectionStatus={onSetProjectionStatus}
              onSubmitProjections={onSubmitProjections}
              onSetProjectionCommitMessage={onSetProjectionCommitMessage}
              onClearProjections={onClearProjections}
              proposals={proposals}
              onProposalAction={onProposalAction}
              proposalActionLoading={proposalActionLoading}
              onReviseProjection={onReviseProjection}
            />
          )}
        </div>
      </div>
    </>
  );
}
