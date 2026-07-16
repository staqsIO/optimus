"use client";

import { Suspense, useEffect, useState, useCallback, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { inboxGet } from "@/components/inbox/shared";
import QueuePanel, { type PipelineSummary } from "@/components/inbox/QueuePanel";
import DetailPanel from "@/components/inbox/DetailPanel";
import BulkActionBar from "@/components/inbox/BulkActionBar";
import { type Draft, type PipelineStats } from "@/components/inbox/QueueItem";

// ---------------------------------------------------------------------------
// DraftsPage — Two-column list+detail layout
// ---------------------------------------------------------------------------

export default function DraftsPage() {
  return (
    <Suspense fallback={<div className="flex h-full" />}>
      <DraftsPageContent />
    </Suspense>
  );
}

function DraftsPageContent() {
  const { data: session } = useSession();
  const searchParams = useSearchParams();
  const idFromUrl = searchParams.get("id");

  // Data
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [stats, setStats] = useState<PipelineStats | null>(null);
  const [pipelineSummary, setPipelineSummary] = useState<PipelineSummary | null>(null);
  const [loading, setLoading] = useState(true);

  // Selection / navigation
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null);
  const [selectedDrafts, setSelectedDrafts] = useState<Set<string>>(new Set());
  const [focusIndex, setFocusIndex] = useState(0);
  const [isEditing, setIsEditing] = useState(false);

  // Filters
  const [filterCategory, setFilterCategory] = useState<string | null>(null);
  const [filterVerdict, setFilterVerdict] = useState<string | null>(null);

  // Bulk action state
  const [bulkSubmitting, setBulkSubmitting] = useState(false);

  // ---- Data fetching ----

  const fetchDrafts = useCallback(async () => {
    try {
      const [draftsRes, statsRes] = await Promise.all([
        inboxGet("/api/drafts", { signal: AbortSignal.timeout(8000) }),
        inboxGet("/api/briefing", { signal: AbortSignal.timeout(8000) }),
      ]);
      const draftsData = await draftsRes.json();
      const statsData = await statsRes.json();
      setDrafts(draftsData.drafts || []);
      setPipelineSummary(draftsData.pipelineSummary || null);
      setStats(statsData.stats || null);
    } catch {
      // silent — will retry on interval
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDrafts();
    const interval = setInterval(fetchDrafts, 10000);
    return () => clearInterval(interval);
  }, [fetchDrafts]);

  // Seed selection from ?id=<proposal_id> deep link (e.g. from /board needs_you cards).
  // Waits until drafts are loaded so the id resolves to an actual row.
  useEffect(() => {
    if (!idFromUrl) return;
    if (drafts.some((d) => d.id === idFromUrl)) {
      setSelectedDraftId(idFromUrl);
    }
  }, [idFromUrl, drafts]);

  // ---- Filtering ----

  const filteredDrafts = useMemo(() => {
    return drafts.filter((d) => {
      if (filterCategory && d.emails.triage_category !== filterCategory)
        return false;
      if (filterVerdict && d.reviewer_verdict !== filterVerdict) return false;
      return true;
    });
  }, [drafts, filterCategory, filterVerdict]);

  // Ordered: high confidence first, then review
  const orderedDrafts = useMemo(() => {
    const high = filteredDrafts.filter((d) => d.confidence_tier === "high");
    const review = filteredDrafts.filter((d) => d.confidence_tier !== "high");
    return [...high, ...review];
  }, [filteredDrafts]);

  // Currently selected draft object
  const selectedDraft = useMemo(
    () => orderedDrafts.find((d) => d.id === selectedDraftId) || null,
    [orderedDrafts, selectedDraftId],
  );

  // High-confidence count for bulk bar
  const readyCount = useMemo(
    () => filteredDrafts.filter((d) => d.confidence_tier === "high").length,
    [filteredDrafts],
  );

  const safeInSelectionCount = useMemo(() => {
    let n = 0;
    for (const id of selectedDrafts) {
      const d = drafts.find((x) => x.id === id);
      if (d?.confidence_tier === "high") n++;
    }
    return n;
  }, [selectedDrafts, drafts]);

  // ---- Selection ----

  const toggleSelect = useCallback((id: string) => {
    setSelectedDrafts((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedDrafts(new Set()), []);

  // ---- Bulk actions ----

  const handleBulkAction = useCallback(
    async (action: "send" | "approve" | "reject") => {
      if (selectedDrafts.size === 0) return;
      setBulkSubmitting(true);
      try {
        await fetch("/api/inbox-proxy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path: "/api/drafts/bulk",
            body: {
              ids: Array.from(selectedDrafts),
              action,
              acted_by:
                (session?.user as Record<string, unknown>)?.login as string ||
                session?.user?.name ||
                null,
            },
          }),
        });
        clearSelection();
        fetchDrafts();
      } finally {
        setBulkSubmitting(false);
      }
    },
    [selectedDrafts, session, clearSelection, fetchDrafts],
  );

  const handleBulkSafeOnly = useCallback(async () => {
    const safeIds = Array.from(selectedDrafts).filter((id) => {
      const d = drafts.find((x) => x.id === id);
      return d?.confidence_tier === "high";
    });
    if (safeIds.length === 0) return;
    setBulkSubmitting(true);
    try {
      await fetch("/api/inbox-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "/api/drafts/bulk",
          body: {
            ids: safeIds,
            action: "send",
            acted_by:
              (session?.user as Record<string, unknown>)?.login as string ||
              session?.user?.name ||
              null,
          },
        }),
      });
      clearSelection();
      fetchDrafts();
    } finally {
      setBulkSubmitting(false);
    }
  }, [selectedDrafts, drafts, session, clearSelection, fetchDrafts]);

  const handleBulkApproveReady = useCallback(async () => {
    const readyIds = filteredDrafts
      .filter((d) => d.confidence_tier === "high")
      .map((d) => d.id);
    if (readyIds.length === 0) return;
    setBulkSubmitting(true);
    try {
      await fetch("/api/inbox-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "/api/drafts/bulk",
          body: {
            ids: readyIds,
            action: "send",
            acted_by:
              (session?.user as Record<string, unknown>)?.login as string ||
              session?.user?.name ||
              null,
          },
        }),
      });
      clearSelection();
      fetchDrafts();
    } finally {
      setBulkSubmitting(false);
    }
  }, [filteredDrafts, session, clearSelection, fetchDrafts]);

  // ---- Keyboard shortcuts ----

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return;

      switch (e.key) {
        case "j":
          e.preventDefault();
          setFocusIndex((i) => Math.min(i + 1, orderedDrafts.length - 1));
          break;
        case "k":
          e.preventDefault();
          setFocusIndex((i) => Math.max(i - 1, 0));
          break;
        case "x":
          e.preventDefault();
          if (orderedDrafts[focusIndex]) toggleSelect(orderedDrafts[focusIndex].id);
          break;
        case "Enter":
          e.preventDefault();
          if (orderedDrafts[focusIndex]) {
            setSelectedDraftId(orderedDrafts[focusIndex].id);
            setIsEditing(false);
          }
          break;
        case "a":
          e.preventDefault();
          if (selectedDraft) {
            // Approve & send the currently viewed draft
            handleSingleAction("send");
          }
          break;
        case "e":
          e.preventDefault();
          if (selectedDraft && !isEditing) {
            setIsEditing(true);
          }
          break;
        // "r" removed — conflicts with Cmd+R page refresh, caused unintentional rejections
        case "Escape":
          e.preventDefault();
          if (isEditing) {
            setIsEditing(false);
          } else if (selectedDraftId) {
            setSelectedDraftId(null);
          } else if (selectedDrafts.size > 0) {
            clearSelection();
          }
          break;
      }
    }

    async function handleSingleAction(action: "send" | "approve" | "reject") {
      if (!selectedDraft) return;
      const endpoint =
        action === "send" ? "/api/drafts/send" : `/api/drafts/${action}`;
      await fetch("/api/inbox-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: endpoint,
          body: {
            id: selectedDraft.id,
            acted_by:
              (session?.user as Record<string, unknown>)?.login as string ||
              session?.user?.name ||
              null,
          },
        }),
      });
      setSelectedDraftId(null);
      fetchDrafts();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    orderedDrafts,
    focusIndex,
    selectedDraftId,
    selectedDraft,
    selectedDrafts.size,
    isEditing,
    session,
    toggleSelect,
    clearSelection,
    fetchDrafts,
  ]);

  // ---- Render ----

  return (
    <div className="flex h-full">
      {/* Left column: QueuePanel */}
      <QueuePanel
        drafts={orderedDrafts}
        stats={stats}
        selectedDraftId={selectedDraftId}
        selectedDrafts={selectedDrafts}
        focusIndex={focusIndex}
        filterCategory={filterCategory}
        onFilterCategory={setFilterCategory}
        filterVerdict={filterVerdict}
        onFilterVerdict={setFilterVerdict}
        onSelectDraft={(id) => {
          setSelectedDraftId(id);
          setIsEditing(false);
        }}
        onToggleSelect={toggleSelect}
        onBulkApproveReady={handleBulkApproveReady}
        loading={loading}
        pipelineSummary={pipelineSummary}
      />

      {/* Right column: DetailPanel */}
      <DetailPanel
        draft={selectedDraft}
        isEditing={isEditing}
        onSetEditing={setIsEditing}
        onAction={() => {
          setSelectedDraftId(null);
          fetchDrafts();
        }}
        onClose={() => setSelectedDraftId(null)}
      />

      {/* Bulk Action Bar */}
      {selectedDrafts.size > 0 && (
        <BulkActionBar
          count={selectedDrafts.size}
          readyCount={readyCount}
          safeInSelectionCount={safeInSelectionCount}
          submitting={bulkSubmitting}
          onAction={handleBulkAction}
          onApproveSafeOnly={
            safeInSelectionCount > 0 && safeInSelectionCount < selectedDrafts.size
              ? handleBulkSafeOnly
              : undefined
          }
          onClear={clearSelection}
        />
      )}
    </div>
  );
}
