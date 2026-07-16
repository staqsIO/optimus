"use client";

import { useCallback, useState, useEffect, Suspense, Component, type ReactNode, type ErrorInfo } from "react";
import { useSearchParams } from "next/navigation";
import DraftReview from "@/components/workstation/DraftReview";
import CommandBar from "@/components/workstation/CommandBar";
import AgendaSlideOver from "@/components/workstation/AgendaSlideOver";
import UnifiedActivityFeed from "@/components/workstation/unified-feed/UnifiedActivityFeed";
import AliveFeed from "@/components/workstation/unified-feed/AliveFeed";
import ContextSidebar from "@/components/workstation/unified-feed/ContextSidebar";
import { useCommandBar } from "@/components/workstation/useCommandBar";
import { useFeedCards } from "@/components/workstation/useFeedCards";
import { useAgenda } from "@/components/workstation/useAgenda";
import type { GapItem, AgendaItem, CommandChip } from "@/components/workstation/types";
import { classifyIntent } from "@/lib/classify-intent";

/* Inline error boundary to isolate which component crashes */
class PanelBoundary extends Component<{ name: string; children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[PanelBoundary:${this.props.name}]`, error.message, info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3 text-xs">
          <span className="text-red-400 font-medium">{this.props.name} crashed:</span>{" "}
          <span className="text-red-300">{this.state.error.message}</span>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function WorkstationPageWrapper() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center min-h-[60vh] text-zinc-500 text-sm">Loading...</div>}>
      <WorkstationPage />
    </Suspense>
  );
}

function WorkstationPage() {
  const commandBar = useCommandBar();
  const feedCards = useFeedCards();
  const agenda = useAgenda();
  const searchParams = useSearchParams();

  const [draftReviewOpen, setDraftReviewOpen] = useState(false);
  // Default sidebar closed on mobile (<1024px), open on desktop
  const [sidebarOpen, setSidebarOpen] = useState(
    typeof window !== "undefined" ? window.innerWidth >= 1024 : true
  );

  // Handle deep-link from governance Accept + Open in Workstation
  useEffect(() => {
    const chip = searchParams.get("chip");
    const prompt = searchParams.get("prompt");
    if (chip === "change" && prompt) {
      commandBar.setActiveChip("change");
      commandBar.setInput(decodeURIComponent(prompt));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Intake submission — now uses feed card system for visibility

  // Classified intent flash — shown briefly when auto-routing
  const [classifiedIntent, setClassifiedIntent] = useState<CommandChip | null>(null);

  // Route to the correct action for a given chip/intent
  const routeToIntent = useCallback((intent: CommandChip, input: string) => {
    switch (intent) {
      case "change":
        feedCards.submitChange(input, commandBar.contextFiles, commandBar.uploadedFiles);
        break;
      case "ask":
        feedCards.submitAsk(input, commandBar.contextFiles, commandBar.uploadedFiles);
        break;
      case "research":
        feedCards.submitResearch(input);
        break;
      case "agenda":
        agenda.openSlideOver();
        return false; // Don't clear input for agenda
      case "intake":
        feedCards.submitIntake(input);
        break;
      case "build":
        feedCards.submitBuild(input);
        break;
    }
    return true;
  }, [feedCards, commandBar.contextFiles, commandBar.uploadedFiles, agenda]);

  // Submit handler — routes based on active chip, or auto-classifies
  const handleSubmit = useCallback(async () => {
    const input = commandBar.input.trim();
    if (!input) return;

    feedCards.clearError();

    // If a chip is manually selected, use it directly
    if (commandBar.activeChip) {
      if (routeToIntent(commandBar.activeChip, input)) {
        commandBar.clearInput();
      }
      return;
    }

    // Auto mode: classify intent
    const result = await classifyIntent(input, {
      hasContextFiles: commandBar.contextFiles.length > 0,
    });

    // Flash the classified intent briefly
    setClassifiedIntent(result.intent);
    setTimeout(() => setClassifiedIntent(null), 1500);

    if (routeToIntent(result.intent, input)) {
      commandBar.clearInput();
    }
  }, [commandBar, feedCards, routeToIntent]);

  // Follow-up from answer card — creates a new ask card
  const handleFollowUp = useCallback(
    (prompt: string) => {
      feedCards.submitAsk(prompt, []);
    },
    [feedCards]
  );

  // Bridge from research gap → change card
  const handleAddToSpec = useCallback(
    (gap: GapItem) => {
      const prompt = `Update SPEC.md to incorporate this finding:\n\nTitle: ${gap.title}\nDescription: ${gap.description}\n${gap.specSection ? `Related section: ${gap.specSection}\n` : ""}${gap.suggestedAction ? `Suggested action: ${gap.suggestedAction}` : ""}`;
      commandBar.setActiveChip("change");
      commandBar.setContextFiles(["spec/SPEC.md"]);
      feedCards.submitChange(prompt, ["spec/SPEC.md"]);
    },
    [commandBar, feedCards]
  );

  // File select from file browser modal → add to context
  const handleFileSelect = useCallback(
    (path: string) => {
      commandBar.addContextFile(path);
    },
    [commandBar]
  );

  // Agenda action handler
  const handleAgendaAction = useCallback(
    (action: { promptTemplate: string; mode: "qa" | "pr"; contextPaths: string[] }, item?: AgendaItem) => {
      if (item) {
        agenda.openDiscuss(item, action.promptTemplate || undefined);
        if (item.specRefs && item.specRefs.length > 0) {
          const sectionIds = item.specRefs.map((r) => r.sectionId);
          agenda.dispatch({
            type: "START_PROJECTION_SESSION",
            itemId: item.id,
            itemTitle: item.title,
            sectionIds,
          });
          for (const sectionId of sectionIds) {
            agenda.requestProjection(item, sectionId);
          }
        }
      }
    },
    [agenda]
  );

  return (
    <div className="flex flex-col h-[calc(100vh-49px)]">
      {/* Command bar — sticky at top */}
      <PanelBoundary name="CommandBar">
        <CommandBar
          input={commandBar.input}
          onInputChange={commandBar.setInput}
          contextFiles={commandBar.contextFiles}
          onRemoveContextFile={commandBar.removeContextFile}
          uploadedFiles={commandBar.uploadedFiles}
          onUploadFile={commandBar.addUploadedFile}
          onRemoveUploadedFile={commandBar.removeUploadedFile}
          activeChip={commandBar.activeChip}
          onChipChange={commandBar.setActiveChip}
          onSubmit={handleSubmit}
          onAgendaClick={agenda.openSlideOver}
          classifiedIntent={classifiedIntent}
          fileBrowserOpen={commandBar.fileBrowserOpen}
          onOpenFileBrowser={commandBar.openFileBrowser}
          onCloseFileBrowser={commandBar.closeFileBrowser}
          onFileSelect={handleFileSelect}
          tree={commandBar.tree}
          treeLoading={commandBar.treeLoading}
          error={feedCards.lastError}
          loading={feedCards.isLoading}
        />
      </PanelBoundary>

      {/* Loading indicator — prominent feedback below command bar */}
      {feedCards.isLoading && (
        <div className="flex items-center gap-3 px-4 md:px-6 py-3 bg-accent-bright/5 border-b border-accent-bright/20">
          <div className="h-4 w-4 border-2 border-accent-bright border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-accent-bright">Thinking...</span>
        </div>
      )}

      {/* Two-column layout: unified feed + context sidebar */}
      <div className="flex-1 flex overflow-hidden">
        {/* Main feed — unified chronological activity stream */}
        <div className="flex-1 overflow-y-auto" id="workstation-feed">
          <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 space-y-6">
            {/* Alive feed — lay-user "what are agents doing right now?" (OPT-42) */}
            <PanelBoundary name="AliveFeed">
              <div className="bg-surface border border-white/[0.06] rounded-xl overflow-hidden">
                <AliveFeed limit={15} />
              </div>
            </PanelBoundary>

            {/* Unified activity feed — board interactions + agent work items */}
            <PanelBoundary name="UnifiedActivityFeed">
              <UnifiedActivityFeed
                feedCards={feedCards.cards}
                feedCardActions={{
                  onIterate: feedCards.iterateCard,
                  onCreatePR: feedCards.createPRFromCard,
                  onDiscard: feedCards.removeCard,
                  onCommitMessageChange: feedCards.updateCardCommitMessage,
                  onFollowUp: handleFollowUp,
                  onAddToSpec: handleAddToSpec,
                }}
              />
            </PanelBoundary>
          </div>
        </div>

        {/* Context sidebar — collapsible dashboard panels */}
        {sidebarOpen && (
          <ContextSidebar
            onDraftClick={() => setDraftReviewOpen(true)}
            onClose={() => setSidebarOpen(false)}
          />
        )}

        {/* Sidebar toggle when closed */}
        {!sidebarOpen && (
          <button
            onClick={() => setSidebarOpen(true)}
            className="absolute right-4 top-[120px] lg:top-[120px] p-2 rounded-lg bg-surface border border-white/10 text-zinc-400 hover:text-zinc-200 hover:bg-white/5 transition-colors z-10"
            aria-label="Open context sidebar"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
              <path d="M3 12h18M3 6h18M3 18h18" />
            </svg>
          </button>
        )}
      </div>

      {/* Agenda slide-over */}
      <PanelBoundary name="AgendaSlideOver">
        <AgendaSlideOver
          open={agenda.state.agendaSlideOverOpen}
          onClose={agenda.closeSlideOver}
          agendaData={agenda.state.agendaData}
          agendaLoading={agenda.state.agendaLoading}
          activeItemId={agenda.state.discussItemId}
          onAction={handleAgendaAction}
          onRefresh={agenda.fetchAgenda}
          onSpecRefClick={(id) => agenda.setActiveSpecSections([id])}
          onActiveSpecSections={agenda.setActiveSpecSections}
          discussOpen={agenda.state.discussOpen}
          discussItem={
            agenda.state.agendaData
              ? agenda.findDiscussItem(agenda.state.agendaData, agenda.state.discussItemId)
              : null
          }
          discussMessages={agenda.state.discussMessages}
          discussLoading={agenda.state.discussLoading}
          onSendDiscuss={agenda.sendDiscussMessage}
          onCloseDiscuss={agenda.closeDiscuss}
          activeSpecSectionIds={agenda.state.activeSpecSections}
          activeSpecContext={agenda.state.activeSpecContext}
          projections={agenda.state.projections}
          projectionStatus={agenda.state.projectionStatus}
          projectionCommitMessage={agenda.state.projectionCommitMessage}
          projectionSourceItemId={agenda.state.projectionSourceItemId}
          onRequestProjection={(sectionId) => {
            const item = agenda.findDiscussItem(
              agenda.state.agendaData!,
              agenda.state.projectionSourceItemId
            );
            if (item) agenda.requestProjection(item, sectionId);
          }}
          onUpdateProjectionEdit={agenda.updateProjectionEdit}
          onSetProjectionStatus={(sectionId, status) =>
            agenda.dispatch({ type: "SET_PROJECTION_STATUS", sectionId, status })
          }
          onSubmitProjections={agenda.submitProjections}
          onSetProjectionCommitMessage={(msg) =>
            agenda.dispatch({ type: "SET_PROJECTION_COMMIT_MESSAGE", message: msg })
          }
          onClearProjections={() => agenda.dispatch({ type: "CLEAR_PROJECTIONS" })}
          proposals={agenda.state.proposals}
          onProposalAction={agenda.handleProposalAction}
          proposalActionLoading={agenda.state.proposalActionLoading}
          onReviseProjection={agenda.reviseProjection}
          onClearDiscussThread={agenda.clearDiscussThread}
        />
      </PanelBoundary>

      {/* Draft review modal */}
      <PanelBoundary name="DraftReview">
        <DraftReview open={draftReviewOpen} onClose={() => setDraftReviewOpen(false)} />
      </PanelBoundary>
    </div>
  );
}
