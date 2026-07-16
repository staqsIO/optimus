"use client";

import { useReducer, useCallback, useEffect } from "react";
import type {
  AgendaData,
  AgendaItem,
  DiscussMessage,
  SpecContextEntry,
  SpecProjection,
  ProjectionStatus,
  DiffLine,
  SpecProposal,
  ProposalAction,
} from "./types";
import { computeLineDiff, contentHash } from "@/lib/diff";

const DISCUSS_STORAGE_PREFIX = "discuss-";
const DISCUSS_MAX_MESSAGES = 50;

interface AgendaState {
  agendaData: AgendaData | null;
  agendaLoading: boolean;
  activeSpecSections: string[];
  activeSpecContext: Record<string, SpecContextEntry[]>;
  discussOpen: boolean;
  discussMessages: DiscussMessage[];
  discussItemId: string | null;
  discussLoading: boolean;
  discussPendingPrompt: string | null;
  projections: Record<string, SpecProjection>;
  projectionStatus: Record<string, ProjectionStatus>;
  projectionCommitMessage: string;
  projectionSourceItemId: string | null;
  agendaSlideOverOpen: boolean;
  error: string;
  prUrl: string;
  stage: string;
  proposals: SpecProposal[];
  proposalActionLoading: boolean;
}

type AgendaAction =
  | { type: "SET_AGENDA_DATA"; data: AgendaData }
  | { type: "SET_AGENDA_LOADING"; loading: boolean }
  | { type: "SET_ACTIVE_SPEC_SECTIONS"; sectionIds: string[]; context: Record<string, SpecContextEntry[]> }
  | { type: "OPEN_DISCUSS"; item: AgendaItem; initialPrompt?: string; storedMessages?: DiscussMessage[] }
  | { type: "CLOSE_DISCUSS" }
  | { type: "ADD_DISCUSS_MESSAGE"; message: DiscussMessage }
  | { type: "SET_DISCUSS_LOADING"; loading: boolean }
  | { type: "CLEAR_DISCUSS_PENDING" }
  | { type: "SET_PROJECTION"; sectionId: string; projection: SpecProjection }
  | { type: "SET_PROJECTION_STATUS"; sectionId: string; status: ProjectionStatus }
  | { type: "UPDATE_PROJECTION_EDIT"; sectionId: string; editedContent: string; diff: DiffLine[] }
  | { type: "SET_PROJECTION_COMMIT_MESSAGE"; message: string }
  | { type: "CLEAR_PROJECTIONS" }
  | { type: "START_PROJECTION_SESSION"; itemId: string; itemTitle: string; sectionIds: string[] }
  | { type: "SET_SLIDE_OVER"; open: boolean }
  | { type: "SET_ERROR"; error: string }
  | { type: "SET_PR_URL"; url: string }
  | { type: "SET_PROPOSALS"; proposals: SpecProposal[] }
  | { type: "SET_PROPOSAL_ACTION_LOADING"; loading: boolean }
  | { type: "REMOVE_PROPOSAL"; proposalId: string }
  | { type: "ADD_PROPOSAL"; proposal: SpecProposal };

const initialAgendaState: AgendaState = {
  agendaData: null,
  agendaLoading: false,
  activeSpecSections: [],
  activeSpecContext: {},
  discussOpen: false,
  discussMessages: [],
  discussItemId: null,
  discussLoading: false,
  discussPendingPrompt: null,
  projections: {},
  projectionStatus: {},
  projectionCommitMessage: "",
  projectionSourceItemId: null,
  agendaSlideOverOpen: false,
  error: "",
  prUrl: "",
  stage: "",
  proposals: [],
  proposalActionLoading: false,
};

function agendaReducer(state: AgendaState, action: AgendaAction): AgendaState {
  switch (action.type) {
    case "SET_AGENDA_DATA":
      return { ...state, agendaData: action.data, agendaLoading: false };
    case "SET_AGENDA_LOADING":
      return { ...state, agendaLoading: action.loading };
    case "SET_ACTIVE_SPEC_SECTIONS":
      return { ...state, activeSpecSections: action.sectionIds, activeSpecContext: action.context };
    case "OPEN_DISCUSS": {
      const specIds = action.item.specRefs?.map((r) => r.sectionId) || [];
      const ctx: Record<string, SpecContextEntry[]> = {};
      for (const id of specIds) {
        ctx[id] = [{ title: action.item.title, file: action.item.source.file }];
      }
      return {
        ...state,
        discussOpen: true,
        discussItemId: action.item.id,
        discussMessages: action.storedMessages || [],
        discussLoading: false,
        discussPendingPrompt: action.initialPrompt || null,
        activeSpecSections: specIds,
        activeSpecContext: ctx,
      };
    }
    case "CLOSE_DISCUSS":
      return {
        ...state,
        discussOpen: false,
        discussMessages: [],
        discussItemId: null,
        discussLoading: false,
        discussPendingPrompt: null,
        projections: {},
        projectionStatus: {},
        projectionCommitMessage: "",
        projectionSourceItemId: null,
      };
    case "ADD_DISCUSS_MESSAGE":
      return { ...state, discussMessages: [...state.discussMessages, action.message] };
    case "SET_DISCUSS_LOADING":
      return { ...state, discussLoading: action.loading };
    case "CLEAR_DISCUSS_PENDING":
      return { ...state, discussPendingPrompt: null };
    case "SET_PROJECTION":
      return {
        ...state,
        projections: { ...state.projections, [action.sectionId]: action.projection },
        projectionStatus: { ...state.projectionStatus, [action.sectionId]: "ready" },
      };
    case "SET_PROJECTION_STATUS":
      return {
        ...state,
        projectionStatus: { ...state.projectionStatus, [action.sectionId]: action.status },
      };
    case "UPDATE_PROJECTION_EDIT":
      return {
        ...state,
        projections: {
          ...state.projections,
          [action.sectionId]: {
            ...state.projections[action.sectionId],
            editedContent: action.editedContent,
            diff: action.diff,
          },
        },
      };
    case "SET_PROJECTION_COMMIT_MESSAGE":
      return { ...state, projectionCommitMessage: action.message };
    case "CLEAR_PROJECTIONS":
      return {
        ...state,
        projections: {},
        projectionStatus: {},
        projectionCommitMessage: "",
        projectionSourceItemId: null,
      };
    case "START_PROJECTION_SESSION": {
      const statusMap: Record<string, ProjectionStatus> = {};
      for (const id of action.sectionIds) {
        statusMap[id] = "loading";
      }
      return {
        ...state,
        projections: {},
        projectionStatus: statusMap,
        projectionCommitMessage: `Update spec per: ${action.itemTitle}`,
        projectionSourceItemId: action.itemId,
      };
    }
    case "SET_SLIDE_OVER":
      return { ...state, agendaSlideOverOpen: action.open };
    case "SET_ERROR":
      return { ...state, error: action.error };
    case "SET_PR_URL":
      return { ...state, prUrl: action.url, stage: "done" };
    case "SET_PROPOSALS":
      return { ...state, proposals: action.proposals };
    case "SET_PROPOSAL_ACTION_LOADING":
      return { ...state, proposalActionLoading: action.loading };
    case "REMOVE_PROPOSAL":
      return { ...state, proposals: state.proposals.filter((p) => p.id !== action.proposalId) };
    case "ADD_PROPOSAL":
      return { ...state, proposals: [...state.proposals, action.proposal] };
    default:
      return state;
  }
}

async function getErrorMessage(res: Response, fallback: string): Promise<string> {
  const text = await res.text().catch(() => fallback);
  try {
    return JSON.parse(text).error || fallback;
  } catch {
    return fallback;
  }
}

export function useAgenda() {
  const [state, dispatch] = useReducer(agendaReducer, initialAgendaState);

  const fetchAgenda = useCallback(async () => {
    dispatch({ type: "SET_AGENDA_LOADING", loading: true });
    try {
      const res = await fetch("/api/workstation/agenda");
      if (!res.ok) {
        throw new Error(await getErrorMessage(res, "Failed to load agenda"));
      }
      const data = await res.json();
      dispatch({ type: "SET_AGENDA_DATA", data: data.agenda });
    } catch (err) {
      dispatch({ type: "SET_AGENDA_LOADING", loading: false });
      dispatch({
        type: "SET_ERROR",
        error: err instanceof Error ? err.message : "Failed to load agenda",
      });
    }
  }, []);

  const openSlideOver = useCallback(() => {
    dispatch({ type: "SET_SLIDE_OVER", open: true });
    if (!state.agendaData && !state.agendaLoading) {
      fetchAgenda();
    }
  }, [state.agendaData, state.agendaLoading, fetchAgenda]);

  const closeSlideOver = useCallback(() => {
    dispatch({ type: "SET_SLIDE_OVER", open: false });
  }, []);

  const setActiveSpecSections = useCallback(
    (sectionIds: string[], context: Record<string, SpecContextEntry[]> = {}) => {
      dispatch({ type: "SET_ACTIVE_SPEC_SECTIONS", sectionIds, context });
    },
    []
  );

  const openDiscuss = useCallback((item: AgendaItem, initialPrompt?: string) => {
    dispatch({ type: "OPEN_DISCUSS", item, initialPrompt });
  }, []);

  const closeDiscuss = useCallback(() => {
    dispatch({ type: "CLOSE_DISCUSS" });
  }, []);

  function findDiscussItem(data: AgendaData, itemId: string | null): AgendaItem | null {
    if (!itemId) return null;
    for (const s of data.sections) {
      const item = s.items.find((i) => i.id === itemId);
      if (item) return item;
    }
    return null;
  }

  const sendDiscussMessage = useCallback(
    async (text: string) => {
      if (!text.trim() || !state.discussItemId || !state.agendaData) return;

      let discussItem: AgendaItem | null = null;
      for (const s of state.agendaData.sections) {
        const found = s.items.find((i) => i.id === state.discussItemId);
        if (found) { discussItem = found; break; }
      }
      if (!discussItem) return;

      const userMsg: DiscussMessage = {
        id: `msg-${Date.now()}-user`,
        role: "user",
        content: text,
        timestamp: new Date().toISOString(),
      };
      dispatch({ type: "ADD_DISCUSS_MESSAGE", message: userMsg });
      dispatch({ type: "SET_DISCUSS_LOADING", loading: true });

      const history = state.discussMessages
        .reduce((pairs: string[], msg, idx, arr) => {
          if (msg.role === "user") {
            const answer = arr[idx + 1];
            pairs.push(`Q: ${msg.content}\nA: ${answer ? answer.content : "(pending)"}`);
          }
          return pairs;
        }, [])
        .join("\n\n");

      const enrichedPrompt = history
        ? `Previous discussion about "${discussItem.title}":\n\n${history}\n\nCurrent question: ${text}`
        : `Regarding agenda item "${discussItem.title}": ${text}`;

      const contextPaths: string[] = [];
      if (discussItem.source?.file) contextPaths.push(discussItem.source.file);
      if (discussItem.specRefs) {
        for (const _ref of discussItem.specRefs) {
          if (!contextPaths.includes("spec/SPEC.md")) {
            contextPaths.push("spec/SPEC.md");
          }
        }
      }

      try {
        const res = await fetch("/api/workstation/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: enrichedPrompt, contextPaths }),
        });
        if (!res.ok) {
          throw new Error(await getErrorMessage(res, "Failed to get answer"));
        }
        const data = await res.json();
        const assistantMsg: DiscussMessage = {
          id: `msg-${Date.now()}-assistant`,
          role: "assistant",
          content: data.answer,
          timestamp: new Date().toISOString(),
          expert: data.expert,
          filesUsed: data.filesUsed,
        };
        dispatch({ type: "ADD_DISCUSS_MESSAGE", message: assistantMsg });
      } catch (err) {
        const errorMsg: DiscussMessage = {
          id: `msg-${Date.now()}-error`,
          role: "assistant",
          content: `Error: ${err instanceof Error ? err.message : "Failed to get response"}`,
          timestamp: new Date().toISOString(),
        };
        dispatch({ type: "ADD_DISCUSS_MESSAGE", message: errorMsg });
      }

      dispatch({ type: "SET_DISCUSS_LOADING", loading: false });
    },
    [state.discussItemId, state.discussMessages, state.agendaData]
  );

  const requestProjection = useCallback(
    async (item: AgendaItem, sectionId: string) => {
      if (!state.agendaData?.specIndex) return;
      const section = state.agendaData.specIndex.sectionMap[sectionId];
      if (!section) return;

      const hash = contentHash(section.content + item.summary);
      if (state.projections[sectionId]?.contentHash === hash) return;

      dispatch({ type: "SET_PROJECTION_STATUS", sectionId, status: "loading" });

      try {
        const res = await fetch("/api/workstation/project", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sectionId,
            sectionHeading: section.heading,
            sectionContent: section.content,
            agendaItemTitle: item.title,
            agendaItemSummary: item.summary,
            sourceFile: item.source.file,
          }),
        });
        if (!res.ok) {
          throw new Error(await getErrorMessage(res, "Projection failed"));
        }
        const data = await res.json();
        const diff = computeLineDiff(section.content, data.projectedContent);
        const projection: SpecProjection = {
          sectionId,
          originalContent: section.content,
          projectedContent: data.projectedContent,
          editedContent: data.projectedContent,
          diff,
          sourceItemId: item.id,
          sourceItemTitle: item.title,
          contentHash: hash,
        };
        dispatch({ type: "SET_PROJECTION", sectionId, projection });
      } catch (err) {
        dispatch({ type: "SET_PROJECTION_STATUS", sectionId, status: "idle" });
        dispatch({
          type: "SET_ERROR",
          error: err instanceof Error ? err.message : "Projection failed",
        });
      }
    },
    [state.agendaData, state.projections]
  );

  const updateProjectionEdit = useCallback(
    (sectionId: string, editedContent: string) => {
      const projection = state.projections[sectionId];
      if (!projection) return;
      const diff = computeLineDiff(projection.originalContent, editedContent);
      dispatch({ type: "UPDATE_PROJECTION_EDIT", sectionId, editedContent, diff });
    },
    [state.projections]
  );

  const submitProjections = useCallback(async (excludedSections?: Set<string>) => {
    if (!state.agendaData?.specIndex) return;

    const readyProjections = Object.values(state.projections).filter(
      (p) =>
        (state.projectionStatus[p.sectionId] === "ready" ||
        state.projectionStatus[p.sectionId] === "editing") &&
        !excludedSections?.has(p.sectionId)
    );
    if (readyProjections.length === 0) return;

    for (const p of readyProjections) {
      dispatch({ type: "SET_PROJECTION_STATUS", sectionId: p.sectionId, status: "submitting" });
    }

    try {
      let sourceItem: AgendaItem | null = null;
      for (const s of state.agendaData.sections) {
        const found = s.items.find((i) => i.id === state.projectionSourceItemId);
        if (found) { sourceItem = found; break; }
      }

      // Per-file approach: each projection maps to its section file
      // Group projections by file (multiple subsections may share one file)
      const fileEdits = new Map<string, { sectionIds: string[]; projections: typeof readyProjections }>();

      for (const proj of readyProjections) {
        const section = state.agendaData.specIndex!.sectionMap[proj.sectionId];
        const file = section?.file;
        if (file) {
          // Per-section file: fetch the file, replace the section content
          if (!fileEdits.has(file)) {
            fileEdits.set(file, { sectionIds: [], projections: [] });
          }
          fileEdits.get(file)!.sectionIds.push(proj.sectionId);
          fileEdits.get(file)!.projections.push(proj);
        }
      }

      const files: { path: string; content: string; action: "update" | "create" }[] = [];

      if (fileEdits.size > 0) {
        // Fetch all affected section files in parallel
        const fileFetchEntries = Array.from(fileEdits.entries());
        const fileContents = await Promise.all(
          fileFetchEntries.map(async ([filename]) => {
            const res = await fetch(
              `/api/workstation/file?path=${encodeURIComponent(`spec/spec/${filename}`)}`
            );
            if (!res.ok) throw new Error(`Failed to fetch spec/${filename}`);
            const data = await res.json();
            return { filename, content: data.content as string };
          })
        );

        for (const { filename, content } of fileContents) {
          const edit = fileEdits.get(filename)!;
          let updatedContent = content;

          // For each projection in this file, replace the section content
          // Work bottom-to-top by line position to avoid offset drift
          const fileLines = updatedContent.split("\n");
          const headingRegex = /^(#{2,3})\s+(\d+(?:\.\d+)?)\.\s+(.+)$/;
          const headings: { line: number; id: string }[] = [];
          for (let i = 0; i < fileLines.length; i++) {
            const m = fileLines[i].match(headingRegex);
            if (m) headings.push({ line: i, id: m[2] });
          }

          // Sort projections by section position (bottom-to-top for safe splicing)
          const sortedProjs = [...edit.projections].sort((a, b) => {
            const aIdx = headings.findIndex((h) => h.id === a.sectionId);
            const bIdx = headings.findIndex((h) => h.id === b.sectionId);
            return bIdx - aIdx;
          });

          for (const proj of sortedProjs) {
            const hIdx = headings.findIndex((h) => h.id === proj.sectionId);
            if (hIdx === -1) continue;
            const start = headings[hIdx].line + 1;
            const end = hIdx + 1 < headings.length ? headings[hIdx + 1].line : fileLines.length;
            const newLines = proj.editedContent.split("\n");
            fileLines.splice(start, end - start, ...newLines);
          }

          files.push({
            path: `spec/spec/${filename}`,
            content: fileLines.join("\n"),
            action: "update",
          });
        }
      } else {
        // Legacy fallback: splice into monolithic SPEC.md
        const specRes = await fetch(
          `/api/workstation/file?path=${encodeURIComponent("spec/SPEC.md")}`
        );
        if (!specRes.ok) throw new Error("Failed to fetch SPEC.md");

        const specData = await specRes.json();
        const specLines = (specData.content as string).split("\n");

        const sorted = [...readyProjections].sort((a, b) => {
          const sA = state.agendaData!.specIndex!.sectionMap[a.sectionId];
          const sB = state.agendaData!.specIndex!.sectionMap[b.sectionId];
          return (sB.contentEnd ?? 0) - (sA.contentEnd ?? 0);
        });

        for (const proj of sorted) {
          const section = state.agendaData!.specIndex!.sectionMap[proj.sectionId];
          if (section.contentStart == null || section.contentEnd == null) continue;
          const newLines = proj.editedContent.split("\n");
          specLines.splice(section.contentStart, section.contentEnd - section.contentStart, ...newLines);
        }

        files.push({
          path: "spec/SPEC.md",
          content: specLines.join("\n"),
          action: "update",
        });
      }

      const res = await fetch("/api/workstation/create-pr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files,
          commitMessage: state.projectionCommitMessage || "Update spec sections",
          prompt: sourceItem?.summary || "Spec projection from board agenda review",
          reasoning: `Projected ${readyProjections.length} spec section(s) from agenda item: ${sourceItem?.title || "unknown"}`,
        }),
      });

      if (!res.ok) {
        throw new Error(await getErrorMessage(res, "PR creation failed"));
      }

      const data = await res.json();
      dispatch({ type: "SET_PR_URL", url: data.prUrl });
      dispatch({ type: "CLEAR_PROJECTIONS" });
    } catch (err) {
      for (const p of readyProjections) {
        dispatch({ type: "SET_PROJECTION_STATUS", sectionId: p.sectionId, status: "ready" });
      }
      dispatch({
        type: "SET_ERROR",
        error: err instanceof Error ? err.message : "Failed to submit projections",
      });
    }
  }, [state.projections, state.projectionStatus, state.projectionCommitMessage, state.projectionSourceItemId, state.agendaData]);

  // --- Proposals ---

  const fetchProposals = useCallback(async () => {
    try {
      const res = await fetch("/api/workstation/proposals?status=pending");
      if (!res.ok) return;
      const data = await res.json();
      dispatch({ type: "SET_PROPOSALS", proposals: data.proposals || [] });
    } catch {
      // Best-effort — don't fail the UI
    }
  }, []);

  const handleProposalAction = useCallback(
    async (proposalId: string, action: ProposalAction, feedback?: string) => {
      // Capture proposal before removing for rollback
      const proposal = state.proposals.find((p) => p.id === proposalId);
      dispatch({ type: "SET_PROPOSAL_ACTION_LOADING", loading: true });
      dispatch({ type: "REMOVE_PROPOSAL", proposalId });
      try {
        const res = await fetch("/api/workstation/proposals", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: proposalId, action, feedback }),
        });
        if (!res.ok) {
          throw new Error(await getErrorMessage(res, "Proposal action failed"));
        }
      } catch (err) {
        // Rollback: restore the proposal
        if (proposal) {
          dispatch({ type: "ADD_PROPOSAL", proposal });
        }
        dispatch({
          type: "SET_ERROR",
          error: err instanceof Error ? err.message : "Proposal action failed",
        });
      }
      dispatch({ type: "SET_PROPOSAL_ACTION_LOADING", loading: false });
    },
    [state.proposals]
  );

  // --- Rework loop: revise a projection with board feedback ---

  const reviseProjection = useCallback(
    async (sectionId: string, feedback: string) => {
      if (!state.agendaData?.specIndex) return;
      const section = state.agendaData.specIndex.sectionMap[sectionId];
      const projection = state.projections[sectionId];
      if (!section || !projection) return;

      dispatch({ type: "SET_PROJECTION_STATUS", sectionId, status: "loading" });

      try {
        const res = await fetch("/api/workstation/revise-projection", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sectionId,
            sectionHeading: section.heading,
            originalContent: projection.originalContent,
            projectedContent: projection.editedContent,
            feedback,
          }),
        });
        if (!res.ok) {
          throw new Error(await getErrorMessage(res, "Revision failed"));
        }
        const data = await res.json();
        const diff = computeLineDiff(section.content, data.projectedContent);
        const revised: SpecProjection = {
          ...projection,
          projectedContent: data.projectedContent,
          editedContent: data.projectedContent,
          diff,
          contentHash: contentHash(section.content + data.projectedContent),
        };
        dispatch({ type: "SET_PROJECTION", sectionId, projection: revised });
      } catch (err) {
        dispatch({ type: "SET_PROJECTION_STATUS", sectionId, status: "ready" });
        dispatch({
          type: "SET_ERROR",
          error: err instanceof Error ? err.message : "Revision failed",
        });
      }
    },
    [state.agendaData, state.projections]
  );

  // --- Persistent discuss threads ---

  // Hydrate discuss messages from localStorage when opening (one atomic dispatch)
  const openDiscussWithHistory = useCallback((item: AgendaItem, initialPrompt?: string) => {
    const storedMessages = (() => {
      try {
        const raw = localStorage.getItem(`${DISCUSS_STORAGE_PREFIX}${item.id}`);
        return raw ? JSON.parse(raw) as DiscussMessage[] : [];
      } catch { return []; }
    })();
    dispatch({ type: "OPEN_DISCUSS", item, initialPrompt, storedMessages });
  }, []);

  // Persist discuss messages to localStorage on each new message
  useEffect(() => {
    if (!state.discussItemId || state.discussMessages.length === 0) return;
    try {
      // FIFO cap
      const toStore = state.discussMessages.slice(-DISCUSS_MAX_MESSAGES);
      localStorage.setItem(
        `${DISCUSS_STORAGE_PREFIX}${state.discussItemId}`,
        JSON.stringify(toStore)
      );
    } catch {
      // Storage full — ignore
    }
  }, [state.discussMessages, state.discussItemId]);

  const clearDiscussThread = useCallback((itemId: string) => {
    try {
      localStorage.removeItem(`${DISCUSS_STORAGE_PREFIX}${itemId}`);
    } catch {
      // Ignore
    }
  }, []);

  // Auto-fetch proposals alongside agenda
  useEffect(() => {
    if (state.agendaData) {
      fetchProposals();
    }
  }, [state.agendaData, fetchProposals]);

  // Auto-send pending prompt when discuss opens
  useEffect(() => {
    if (state.discussOpen && state.discussPendingPrompt && state.discussItemId && !state.discussLoading) {
      const prompt = state.discussPendingPrompt;
      dispatch({ type: "CLEAR_DISCUSS_PENDING" });
      sendDiscussMessage(prompt);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.discussOpen, state.discussPendingPrompt]);

  return {
    state,
    dispatch,
    fetchAgenda,
    openSlideOver,
    closeSlideOver,
    setActiveSpecSections,
    openDiscuss: openDiscussWithHistory,
    closeDiscuss,
    sendDiscussMessage,
    requestProjection,
    updateProjectionEdit,
    submitProjections,
    findDiscussItem,
    fetchProposals,
    handleProposalAction,
    reviseProjection,
    clearDiscussThread,
  };
}
