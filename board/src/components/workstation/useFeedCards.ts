"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import type { FeedCard, GenerationResult, ResearchResult, UploadedFile } from "./types";
import { opsPost, opsFetch } from "@/lib/ops-api";

const STORAGE_KEY = "workstation-feed-cards";
const MAX_PERSISTED = 50;
const TTL_MS = 24 * 60 * 60 * 1000; // 24h

/** Load persisted cards from localStorage, filtering stale/loading entries */
function loadFromStorage(): FeedCard[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as FeedCard[];
    const now = Date.now();
    return parsed
      .filter((c) => now - c.createdAt < TTL_MS) // expire old cards
      .filter((c) => c.stage !== "loading" && c.stage !== "submitting") // skip in-flight
      .slice(0, MAX_PERSISTED);
  } catch {
    return [];
  }
}

/** Persist cards to localStorage (debounced by caller) */
function saveToStorage(cards: FeedCard[]) {
  if (typeof window === "undefined") return;
  try {
    // Don't persist cards with large result payloads (file diffs) — truncate
    const slim = cards.slice(0, MAX_PERSISTED).map((c) => {
      if (c.type === "change" && c.result?.files) {
        return { ...c, result: { ...c.result, files: c.result.files.map((f) => ({ ...f, content: f.content?.slice(0, 500) })) } };
      }
      return c;
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(slim));
  } catch { /* storage full or unavailable */ }
}

async function getErrorMessage(res: Response, fallback: string): Promise<string> {
  const text = await res.text().catch(() => fallback);
  try {
    return JSON.parse(text).error || fallback;
  } catch {
    return fallback;
  }
}

export function useFeedCards() {
  const [cards, setCards] = useState<FeedCard[]>(loadFromStorage);
  const [lastError, setLastError] = useState<string | null>(null);

  // Debounced localStorage sync
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveToStorage(cards), 300);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [cards]);

  const updateCard = useCallback((id: string, patch: Partial<FeedCard>) => {
    setCards((prev) =>
      prev.map((c) => (c.id === id ? ({ ...c, ...patch } as FeedCard) : c))
    );
  }, []);

  const removeCard = useCallback((id: string) => {
    setCards((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const submitChange = useCallback(
    async (prompt: string, contextFiles: string[], uploadedFiles?: UploadedFile[]) => {
      const id = `card-${Date.now()}`;
      const card: FeedCard = {
        id,
        type: "change",
        createdAt: Date.now(),
        input: prompt,
        contextFiles,
        stage: "loading",
      };
      setCards((prev) => [card, ...prev]);

      try {
        const res = await fetch("/api/workstation/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt,
            contextPaths: contextFiles.length ? contextFiles : undefined,
            uploadedFiles: uploadedFiles?.length
              ? uploadedFiles.map((f) => ({ name: f.name, mimeType: f.mimeType, base64: f.base64 }))
              : undefined,
          }),
        });
        if (!res.ok) {
          throw new Error(await getErrorMessage(res, "Generation failed"));
        }
        const data: GenerationResult = await res.json();
        updateCard(id, {
          stage: "preview",
          result: data,
          commitMessage: data.commitMessage,
          reasoning: data.reasoning,
        } as Partial<FeedCard>);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "Unknown error";
        console.error("[workstation] Change generation failed:", errorMsg);
        setLastError(errorMsg);
        updateCard(id, {
          stage: "preview",
          error: errorMsg,
        } as Partial<FeedCard>);
      }

      return id;
    },
    [updateCard]
  );

  const submitAsk = useCallback(
    async (prompt: string, contextFiles: string[], uploadedFiles?: UploadedFile[]) => {
      const id = `card-${Date.now()}`;
      const card: FeedCard = {
        id,
        type: "answer",
        createdAt: Date.now(),
        input: prompt,
        contextFiles,
        stage: "loading",
      };
      setCards((prev) => [card, ...prev]);

      try {
        const res = await fetch("/api/workstation/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt,
            contextPaths: contextFiles.length ? contextFiles : undefined,
            uploadedFiles: uploadedFiles?.length
              ? uploadedFiles.map((f) => ({ name: f.name, mimeType: f.mimeType, base64: f.base64 }))
              : undefined,
          }),
        });
        if (!res.ok) {
          throw new Error(await getErrorMessage(res, "Failed to get answer"));
        }
        const data = await res.json();
        updateCard(id, {
          stage: "answered",
          answer: data.answer,
          expert: data.expert,
          filesUsed: data.filesUsed,
          action: data.action,
        } as Partial<FeedCard>);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "Unknown error";
        console.error("[workstation] Ask failed:", errorMsg);
        setLastError(errorMsg);
        updateCard(id, {
          stage: "answered",
          error: errorMsg,
        } as Partial<FeedCard>);
      }

      return id;
    },
    [updateCard]
  );

  const submitResearch = useCallback(
    async (input: string) => {
      const id = `card-${Date.now()}`;
      const detectedType = /^https?:\/\//i.test(input.trim()) ? "url" : "text";

      const card: FeedCard = {
        id,
        type: "research",
        createdAt: Date.now(),
        input,
        contextFiles: [],
        stage: "loading",
      };
      setCards((prev) => [card, ...prev]);

      try {
        const submitResult = await opsPost<{ ok: boolean; id: string }>(
          "/api/research",
          { content: input.trim(), type: detectedType }
        );
        if (!submitResult.ok) {
          throw new Error(submitResult.error);
        }

        const jobId = submitResult.data.id;
        updateCard(id, { stage: "analyzing", jobId } as Partial<FeedCard>);

        // Poll until complete
        const maxAttempts = 120;
        for (let i = 0; i < maxAttempts; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          const poll = await opsFetch<{
            status: "processing" | "completed" | "failed";
            result?: ResearchResult;
            error?: string;
          }>(`/api/research?id=${encodeURIComponent(jobId)}`);

          if (!poll) continue;
          if (poll.status === "completed" && poll.result) {
            updateCard(id, {
              stage: "done",
              result: poll.result,
              jobId: undefined,
            } as Partial<FeedCard>);
            return id;
          }
          if (poll.status === "failed") {
            throw new Error(poll.error || "Research analysis failed");
          }
        }
        throw new Error("Research timed out after 6 minutes");
      } catch (err) {
        updateCard(id, {
          stage: "done",
          error: err instanceof Error ? err.message : "Unknown error",
        } as Partial<FeedCard>);
      }

      return id;
    },
    [updateCard]
  );

  const submitIntake = useCallback(
    async (input: string) => {
      const id = `card-${Date.now()}`;
      const isUrl = /^https?:\/\//.test(input.trim());
      const card: FeedCard = {
        id,
        type: "intake",
        createdAt: Date.now(),
        input,
        contextFiles: [],
        stage: "submitting",
      };
      setCards((prev) => [card, ...prev]);

      try {
        const res = await fetch("/api/governance?path=/api/governance/submit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: input.slice(0, 200),
            contentType: isUrl ? "external_reference" : "idea",
            sourceFormat: isUrl ? "url" : "markdown",
            rawContent: isUrl ? null : input,
            sourceUrl: isUrl ? input : null,
            // submittedBy derived server-side from X-Board-User header
          }),
        });

        if (!res.ok) {
          throw new Error("Submission failed");
        }
        const data = await res.json();
        updateCard(id, {
          stage: "submitted",
          submissionId: data.id,
        } as Partial<FeedCard>);

        // Poll for classification result (Haiku auto-classifies within ~5s)
        if (data.id) {
          for (let i = 0; i < 10; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            try {
              const poll = await fetch(`/api/governance?path=/api/governance/${data.id}`);
              if (poll.ok) {
                const sub = await poll.json();
                if (sub.classification_result) {
                  updateCard(id, {
                    stage: "classified",
                    classification: sub.classification_result,
                  } as Partial<FeedCard>);
                  break;
                }
              }
            } catch { /* continue polling */ }
          }
        }
      } catch (err) {
        updateCard(id, {
          stage: "submitted",
          error: err instanceof Error ? err.message : "Unknown error",
        } as Partial<FeedCard>);
      }

      return id;
    },
    [updateCard]
  );

  const iterateCard = useCallback(
    async (cardId: string, iteratePrompt: string) => {
      const card = cards.find((c) => c.id === cardId);
      if (!card || card.type !== "change" || !card.result) return;

      updateCard(cardId, { stage: "iterating", iteratePrompt } as Partial<FeedCard>);

      try {
        const res = await fetch("/api/workstation/iterate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: iteratePrompt,
            originalPrompt: card.input,
            previousResponse: card.result,
          }),
        });
        if (!res.ok) {
          throw new Error(await getErrorMessage(res, "Iteration failed"));
        }
        const data: GenerationResult = await res.json();
        updateCard(cardId, {
          stage: "preview",
          result: data,
          commitMessage: data.commitMessage,
          reasoning: data.reasoning,
          iteratePrompt: "",
          error: undefined,
        } as Partial<FeedCard>);
      } catch (err) {
        updateCard(cardId, {
          stage: "preview",
          error: err instanceof Error ? err.message : "Unknown error",
        } as Partial<FeedCard>);
      }
    },
    [cards, updateCard]
  );

  const createPRFromCard = useCallback(
    async (cardId: string) => {
      const card = cards.find((c) => c.id === cardId);
      if (!card || card.type !== "change" || !card.result) return;

      updateCard(cardId, { stage: "creating-pr" } as Partial<FeedCard>);

      try {
        const res = await fetch("/api/workstation/create-pr", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            files: card.result.files,
            commitMessage: card.commitMessage,
            prompt: card.input,
            reasoning: card.result.reasoning,
          }),
        });
        if (!res.ok) {
          throw new Error(await getErrorMessage(res, "PR creation failed"));
        }
        const data = await res.json();
        updateCard(cardId, {
          stage: "done",
          prUrl: data.prUrl,
          error: undefined,
        } as Partial<FeedCard>);
      } catch (err) {
        updateCard(cardId, {
          stage: "preview",
          error: err instanceof Error ? err.message : "Unknown error",
        } as Partial<FeedCard>);
      }
    },
    [cards, updateCard]
  );

  const updateCardCommitMessage = useCallback(
    (cardId: string, message: string) => {
      updateCard(cardId, { commitMessage: message } as Partial<FeedCard>);
    },
    [updateCard]
  );

  const submitBuild = useCallback(
    async (prompt: string) => {
      const id = `card-${Date.now()}`;
      const card: FeedCard = {
        id,
        type: "build",
        createdAt: Date.now(),
        input: prompt,
        contextFiles: [],
        stage: "submitting",
      };
      setCards((prev) => [card, ...prev]);

      try {
        // Create a campaign via the campaigns API — build = stateless campaign with defaults
        const result = await opsPost<{ ok: boolean; campaign_id: string; work_item_id: string; status: string }>(
          "/api/campaigns",
          {
            goal_description: prompt,
            campaign_mode: "stateless",
            budget_envelope_usd: 5.00,
            max_iterations: 10,
            iteration_time_budget: "5 minutes",
            success_criteria: [{ metric: "quality_score", operator: ">=", threshold: 0.8 }],
            auto_approve: true,
            metadata: { campaign_type: "build", source: "workstation_chip" },
          }
        );
        if (!result.ok) {
          throw new Error(result.error);
        }
        const campaignId = result.data.campaign_id;
        updateCard(id, {
          stage: "submitted",
          campaignId,
        } as Partial<FeedCard>);

        // Poll campaign status
        let polls = 0;
        const maxPolls = 60; // ~5 min (campaigns take longer)
        const pollInterval = setInterval(async () => {
          polls++;
          if (polls > maxPolls) {
            clearInterval(pollInterval);
            return;
          }
          try {
            const data = await opsFetch<{
              campaign: {
                campaign_status: string;
                completed_iterations: number;
                max_iterations: number;
                spent_usd: string;
                budget_envelope_usd: string;
                iterations: Array<{ iteration_number: number; quality_score: number; decision: string }> | null;
              };
            }>(`/api/campaigns/${campaignId}`);
            if (!data?.campaign) return;

            const cs = data.campaign.campaign_status;
            const stage = cs === "succeeded" ? "completed"
              : cs === "failed" || cs === "cancelled" ? "failed"
              : cs === "running" ? "in_progress"
              : cs === "approved" ? "submitted"
              : "submitting";

            const bestScore = data.campaign.iterations
              ?.filter((i) => i.decision === "keep" || i.decision === "stop_success")
              .reduce((best, i) => Math.max(best, i.quality_score ?? 0), 0) ?? null;

            updateCard(id, {
              stage,
              campaignId,
              iterations: data.campaign.completed_iterations,
              maxIterations: data.campaign.max_iterations,
              spentUsd: parseFloat(data.campaign.spent_usd || "0"),
              bestScore,
            } as Partial<FeedCard>);

            if (cs === "succeeded" || cs === "failed" || cs === "cancelled") {
              clearInterval(pollInterval);
            }
          } catch { /* polling failure is non-fatal */ }
        }, 5000);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "Failed to submit build campaign";
        console.error("[workstation] Build submission failed:", errorMsg);
        setLastError(errorMsg);
        updateCard(id, {
          stage: "failed",
          error: errorMsg,
        } as Partial<FeedCard>);
      }

      return id;
    },
    [updateCard]
  );

  const clearError = useCallback(() => setLastError(null), []);

  const isLoading = cards.some(c => c.stage === "loading" || c.stage === "submitting");

  return {
    cards,
    isLoading,
    lastError,
    clearError,
    submitChange,
    submitAsk,
    submitResearch,
    submitIntake,
    submitBuild,
    iterateCard,
    createPRFromCard,
    removeCard,
    updateCard,
    updateCardCommitMessage,
  };
}
