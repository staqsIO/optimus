"use client";

import { useState, type ReactNode, Component, type ErrorInfo } from "react";
import OpsPulse from "../OpsPulse";
import PipelineHealthPanel from "../PipelineHealthPanel";
import OrgTopologyPanel from "../OrgTopologyPanel";
import LearningInsightsPanel from "../LearningInsightsPanel";
import AutonomyControlsPanel from "../AutonomyControlsPanel";
import CampaignsPanel from "../CampaignsPanel";

class PanelBoundary extends Component<{ name: string; children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[PanelBoundary:${this.props.name}]`, error.message, info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-2 text-[10px]">
          <span className="text-red-400">{this.props.name} error</span>
        </div>
      );
    }
    return this.props.children;
  }
}

interface AccordionProps {
  title: string;
  defaultOpen?: boolean;
  badge?: string;
  children: ReactNode;
}

function Accordion({ title, defaultOpen = false, badge, children }: AccordionProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-white/5">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2.5 text-left hover:bg-white/[0.02] transition-colors"
      >
        <div className="flex items-center gap-2">
          <svg
            className={`w-3 h-3 text-zinc-500 transition-transform ${open ? "rotate-90" : ""}`}
            fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
          </svg>
          <span className="text-xs font-medium text-zinc-300">{title}</span>
          {badge && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-accent-bright/10 text-accent-bright">{badge}</span>
          )}
        </div>
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
}

interface Props {
  onDraftClick: () => void;
  onClose: () => void;
}

export default function ContextSidebar({ onDraftClick, onClose }: Props) {
  const sidebarContent = (
    <>
      {/* Sidebar header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-white/5">
        <span className="text-[10px] uppercase tracking-wider font-semibold text-zinc-500">Context</span>
        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-white/5 text-zinc-500 hover:text-zinc-300 transition-colors"
          aria-label="Close sidebar"
        >
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
            <path d="M11 3L3 11M3 3l8 8" />
          </svg>
        </button>
      </div>

      {/* Panels as accordion sections */}
      <Accordion title="Ops Pulse" defaultOpen badge="Key Metrics">
        <PanelBoundary name="OpsPulse">
          <div className="overflow-x-auto -mx-1 px-1 [&>*]:text-xs [&>*]:gap-2">
            <OpsPulse onDraftClick={onDraftClick} />
          </div>
        </PanelBoundary>
      </Accordion>

      <Accordion title="Pipeline Health">
        <PanelBoundary name="PipelineHealth">
          <PipelineHealthPanel />
        </PanelBoundary>
      </Accordion>

      <Accordion title="Org Topology">
        <PanelBoundary name="OrgTopology">
          <OrgTopologyPanel />
        </PanelBoundary>
      </Accordion>

      <Accordion title="Autonomy Controls">
        <PanelBoundary name="AutonomyControls">
          <AutonomyControlsPanel />
        </PanelBoundary>
      </Accordion>

      <Accordion title="Learning Insights">
        <PanelBoundary name="LearningInsights">
          <LearningInsightsPanel />
        </PanelBoundary>
      </Accordion>

      <Accordion title="Campaigns">
        <PanelBoundary name="Campaigns">
          <CampaignsPanel />
        </PanelBoundary>
      </Accordion>
    </>
  );

  return (
    <>
      {/* Desktop: inline sidebar */}
      <div className="hidden lg:block w-72 shrink-0 border-l border-white/10 bg-surface overflow-y-auto">
        {sidebarContent}
      </div>

      {/* Mobile/tablet: slide-over drawer from right */}
      <div className="lg:hidden">
        <div
          className="fixed inset-0 bg-black/60 z-40"
          onClick={onClose}
        />
        <div className="fixed inset-y-0 right-0 w-72 max-w-[85vw] bg-zinc-900 border-l border-white/10 z-50 overflow-y-auto">
          {sidebarContent}
        </div>
      </div>
    </>
  );
}
