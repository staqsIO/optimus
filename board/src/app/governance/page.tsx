"use client";

import { useState, useCallback } from "react";
import { useSession } from "next-auth/react";
import SubmissionInbox from "../../components/governance/SubmissionInbox";
import SubmitForm from "../../components/governance/SubmitForm";
import SystemState from "../../components/governance/SystemState";
import HaltResumeControl from "../../components/governance/HaltResumeControl";
import DeadManSwitchControl from "../../components/governance/DeadManSwitchControl";
import DirectiveForm from "../../components/governance/DirectiveForm";
import StrategicDecisions from "../../components/governance/StrategicDecisions";
import AgentIntents from "../../components/governance/AgentIntents";
import SharingMetrics from "../../components/governance/SharingMetrics";

type GovernanceTab = "overview" | "decisions" | "intents";

const TABS: { key: GovernanceTab; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "decisions", label: "Strategic Decisions" },
  { key: "intents", label: "Agent Intents" },
];

export default function GovernancePage() {
  const { data: session, status } = useSession();
  const [refreshKey, setRefreshKey] = useState(0);
  const [activeTab, setActiveTab] = useState<GovernanceTab>("overview");

  const handleSubmitted = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  if (status === "loading") {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <span className="text-zinc-500 text-sm">Loading...</span>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <span className="text-zinc-500 text-sm">Sign in to access governance</span>
      </div>
    );
  }

  return (
    <main className="max-w-4xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-zinc-100">Governance Inbox</h1>
          <p className="text-sm text-zinc-500 mt-1">
            Review submissions, audit results, and board decisions
          </p>
        </div>
        {activeTab === "overview" && <SubmitForm onSubmitted={handleSubmitted} />}
      </div>

      {/* Top-level tab selector */}
      <div className="flex gap-1.5 border-b border-white/5 pb-3">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            className={`px-4 py-2 text-sm rounded-lg transition-colors ${
              activeTab === t.key
                ? "bg-white/[0.08] text-zinc-100"
                : "text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-300"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === "overview" && (
        <>
          <HaltResumeControl />
          <DeadManSwitchControl />
          <DirectiveForm onCreated={handleSubmitted} />
          <SubmissionInbox key={refreshKey} />
          <SystemState />
          <SharingMetrics />
        </>
      )}

      {activeTab === "decisions" && <StrategicDecisions />}

      {activeTab === "intents" && <AgentIntents />}
    </main>
  );
}
