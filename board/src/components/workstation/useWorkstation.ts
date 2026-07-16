"use client";

import { useReducer, useCallback, useEffect } from "react";
import type {
  TreeNode,
  FileContent,
  GenerationResult,
  Stage,
  QuickAction,
  Mode,
  AgendaData,
  AgendaItem,
  DiscussMessage,
  SpecContextEntry,
  SpecProjection,
  ProjectionStatus,
  DiffLine,
  ResearchResult,
} from "./types";
import { computeLineDiff, contentHash } from "@/lib/diff";
import { opsPost, opsFetch } from "@/lib/ops-api";

export const QUICK_ACTIONS: QuickAction[] = [
  {
    id: "update-spec",
    label: "Update the spec",
    icon: "\u{1F4CB}",
    contextPaths: ["spec/SPEC.md"],
    promptTemplate: "",
  },
  {
    id: "conversation-entry",
    label: "Write a conversation entry",
    icon: "\u{1F4AC}",
    contextPaths: [],
    promptTemplate:
      "Write a new conversation entry for spec/conversation/. Follow the naming convention NNN-author-description.md and use the format from prior entries.",
  },
  {
    id: "add-adr",
    label: "Add an architecture decision",
    icon: "\u{1F3D7}",
    contextPaths: [],
    promptTemplate:
      "Create a new ADR in autobot-inbox/docs/internal/adrs/. Follow the template in the ADR README. Number it as the next in sequence.",
  },
  {
    id: "review-config",
    label: "Review agent config",
    icon: "\u{1F916}",
    contextPaths: ["autobot-inbox/config/agents.json"],
    promptTemplate: "",
  },
  {
    id: "custom",
    label: "Custom prompt",
    icon: "\u{270F}\u{FE0F}",
    contextPaths: [],
    promptTemplate: "",
  },
];

export const QA_QUICK_ACTIONS: QuickAction[] = [
  {
    id: "qa-whats-happening",
    label: "What's the current status?",
    icon: "\u{1F4CA}",
    contextPaths: ["CLAUDE.md", "autobot-inbox/CLAUDE.md"],
    promptTemplate:
      "What is the current state of the Optimus project? What phase are we in and what's been shipped?",
  },
  {
    id: "qa-spec-question",
    label: "Ask about the spec",
    icon: "\u{1F4D6}",
    contextPaths: ["spec/SPEC.md"],
    promptTemplate: "",
  },
  {
    id: "qa-architecture",
    label: "How does something work?",
    icon: "\u{1F527}",
    contextPaths: ["autobot-inbox/CLAUDE.md"],
    promptTemplate: "",
  },
  {
    id: "qa-custom",
    label: "Ask anything",
    icon: "\u{2753}",
    contextPaths: [],
    promptTemplate: "",
  },
];

export const RESEARCH_QUICK_ACTIONS: QuickAction[] = [
  {
    id: "research-url",
    label: "Analyze a URL",
    icon: "\u{1F517}",
    contextPaths: [],
    promptTemplate: "https://",
  },
  {
    id: "research-article",
    label: "Paste an article",
    icon: "\u{1F4F0}",
    contextPaths: [],
    promptTemplate: "",
  },
  {
    id: "research-paper",
    label: "Analyze a research paper",
    icon: "\u{1F4DA}",
    contextPaths: [],
    promptTemplate: "",
  },
  {
    id: "research-competitor",
    label: "Competitive analysis",
    icon: "\u{1F50D}",
    contextPaths: [],
    promptTemplate: "",
  },
];

interface State {
  mode: Mode;
  tree: TreeNode[];
  treeLoading: boolean;
  selectedFile: FileContent | null;
  fileLoading: boolean;
  contextFiles: string[];
  prompt: string;
  stage: Stage;
  result: GenerationResult | null;
  qaAnswer: string;
  qaExpert: string;
  qaFilesUsed: string[];
  commitMessage: string;
  iteratePrompt: string;
  error: string;
  prUrl: string;
  showReasoning: boolean;
  fileBrowserOpen: boolean;
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
  draftReviewOpen: boolean;
  researchResult: ResearchResult | null;
  researchInput: string;
  researchJobId: string | null;
}

type Action =
  | { type: "SET_MODE"; mode: Mode }
  | { type: "SET_TREE"; tree: TreeNode[] }
  | { type: "SET_TREE_LOADING"; loading: boolean }
  | { type: "SET_SELECTED_FILE"; file: FileContent | null }
  | { type: "SET_FILE_LOADING"; loading: boolean }
  | { type: "ADD_CONTEXT_FILE"; path: string }
  | { type: "REMOVE_CONTEXT_FILE"; path: string }
  | { type: "SET_CONTEXT_FILES"; paths: string[] }
  | { type: "SET_PROMPT"; prompt: string }
  | { type: "SET_STAGE"; stage: Stage }
  | { type: "SET_RESULT"; result: GenerationResult }
  | { type: "SET_QA_ANSWER"; answer: string; expert?: string; filesUsed?: string[] }
  | { type: "SET_COMMIT_MESSAGE"; message: string }
  | { type: "SET_ITERATE_PROMPT"; prompt: string }
  | { type: "SET_ERROR"; error: string }
  | { type: "SET_PR_URL"; url: string }
  | { type: "TOGGLE_REASONING" }
  | { type: "TOGGLE_FILE_BROWSER" }
  | { type: "CLOSE_FILE_BROWSER" }
  | { type: "SET_AGENDA_DATA"; data: AgendaData }
  | { type: "SET_AGENDA_LOADING"; loading: boolean }
  | { type: "SET_ACTIVE_SPEC_SECTIONS"; sectionIds: string[]; context: Record<string, SpecContextEntry[]> }
  | { type: "OPEN_DISCUSS"; item: AgendaItem; initialPrompt?: string }
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
  | { type: "OPEN_DRAFT_REVIEW" }
  | { type: "CLOSE_DRAFT_REVIEW" }
  | { type: "BRIDGE_TO_MODE"; mode: "qa" | "pr"; contextPaths: string[]; prompt: string }
  | { type: "SET_RESEARCH_RESULT"; result: ResearchResult }
  | { type: "SET_RESEARCH_INPUT"; input: string }
  | { type: "SET_RESEARCH_JOB_ID"; jobId: string | null }
  | { type: "RESET" };

const initialState: State = {
  mode: "feed",
  tree: [],
  treeLoading: false,
  selectedFile: null,
  fileLoading: false,
  contextFiles: [],
  prompt: "",
  stage: "input",
  result: null,
  qaAnswer: "",
  qaExpert: "",
  qaFilesUsed: [],
  commitMessage: "",
  iteratePrompt: "",
  error: "",
  prUrl: "",
  showReasoning: false,
  fileBrowserOpen: false,
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
  draftReviewOpen: false,
  researchResult: null,
  researchInput: "",
  researchJobId: null,
};

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "SET_MODE":
      return {
        ...state,
        mode: action.mode,
        stage: "input",
        prompt: "",
        contextFiles: [],
        result: null,
        qaAnswer: "",
        qaExpert: "",
        qaFilesUsed: [],
        error: "",
        researchResult: null,
        researchInput: "",
        researchJobId: null,
      };
    case "SET_TREE":
      return { ...state, tree: action.tree, treeLoading: false };
    case "SET_TREE_LOADING":
      return { ...state, treeLoading: action.loading };
    case "SET_SELECTED_FILE":
      return { ...state, selectedFile: action.file, fileLoading: false };
    case "SET_FILE_LOADING":
      return { ...state, fileLoading: action.loading };
    case "ADD_CONTEXT_FILE":
      if (state.contextFiles.includes(action.path)) return state;
      return { ...state, contextFiles: [...state.contextFiles, action.path] };
    case "REMOVE_CONTEXT_FILE":
      return {
        ...state,
        contextFiles: state.contextFiles.filter((p) => p !== action.path),
      };
    case "SET_CONTEXT_FILES":
      return { ...state, contextFiles: action.paths };
    case "SET_PROMPT":
      return { ...state, prompt: action.prompt };
    case "SET_STAGE":
      return { ...state, stage: action.stage };
    case "SET_RESULT":
      return {
        ...state,
        result: action.result,
        commitMessage: action.result.commitMessage,
        stage: "review",
      };
    case "SET_QA_ANSWER":
      return {
        ...state,
        qaAnswer: action.answer,
        qaExpert: action.expert || "",
        qaFilesUsed: action.filesUsed || [],
        stage: "qa-response",
      };
    case "SET_COMMIT_MESSAGE":
      return { ...state, commitMessage: action.message };
    case "SET_ITERATE_PROMPT":
      return { ...state, iteratePrompt: action.prompt };
    case "SET_ERROR":
      return { ...state, error: action.error };
    case "SET_PR_URL":
      return { ...state, prUrl: action.url, stage: "done" };
    case "TOGGLE_REASONING":
      return { ...state, showReasoning: !state.showReasoning };
    case "TOGGLE_FILE_BROWSER":
      return { ...state, fileBrowserOpen: !state.fileBrowserOpen };
    case "CLOSE_FILE_BROWSER":
      return { ...state, fileBrowserOpen: false };
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
        discussMessages: [],
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
      return {
        ...state,
        discussMessages: [...state.discussMessages, action.message],
      };
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
    case "OPEN_DRAFT_REVIEW":
      return { ...state, draftReviewOpen: true };
    case "CLOSE_DRAFT_REVIEW":
      return { ...state, draftReviewOpen: false };
    case "SET_RESEARCH_RESULT":
      return {
        ...state,
        researchResult: action.result,
        stage: "research-results",
      };
    case "SET_RESEARCH_INPUT":
      return { ...state, researchInput: action.input };
    case "SET_RESEARCH_JOB_ID":
      return { ...state, researchJobId: action.jobId };
    case "BRIDGE_TO_MODE":
      return {
        ...state,
        mode: action.mode,
        stage: "input",
        contextFiles: action.contextPaths,
        prompt: action.prompt,
        result: null,
        qaAnswer: "",
        qaExpert: "",
        qaFilesUsed: [],
        error: "",
        discussOpen: false,
        discussMessages: [],
        discussItemId: null,
        discussPendingPrompt: null,
      };
    case "RESET":
      return { ...initialState, tree: state.tree, mode: state.mode, agendaData: state.agendaData };
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

export function useWorkstation() {
  const [state, dispatch] = useReducer(reducer, initialState);

  // Fetch repo tree on mount
  useEffect(() => {
    dispatch({ type: "SET_TREE_LOADING", loading: true });
    fetch("/api/workstation/tree")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("Failed to load file tree"))))
      .then((data) => dispatch({ type: "SET_TREE", tree: data.tree }))
      .catch((err) => {
        dispatch({ type: "SET_TREE_LOADING", loading: false });
        dispatch({ type: "SET_ERROR", error: err instanceof Error ? err.message : "Failed to load file tree" });
      });
  }, []);

  const selectFile = useCallback(async (path: string) => {
    dispatch({ type: "SET_FILE_LOADING", loading: true });
    try {
      const res = await fetch(
        `/api/workstation/file?path=${encodeURIComponent(path)}`
      );
      if (!res.ok) {
        const errText = await res.text().catch(() => "Failed to load file");
        let errMsg: string;
        try {
          errMsg = JSON.parse(errText).error || errText;
        } catch {
          errMsg = errText;
        }
        throw new Error(errMsg);
      }
      const data = await res.json();
      dispatch({ type: "SET_SELECTED_FILE", file: data });
    } catch (err) {
      dispatch({ type: "SET_FILE_LOADING", loading: false });
      dispatch({ type: "SET_ERROR", error: err instanceof Error ? err.message : "Failed to load file" });
    }
  }, []);

  const addContextFile = useCallback((path: string) => {
    dispatch({ type: "ADD_CONTEXT_FILE", path });
  }, []);

  const removeContextFile = useCallback((path: string) => {
    dispatch({ type: "REMOVE_CONTEXT_FILE", path });
  }, []);

  const applyQuickAction = useCallback((action: QuickAction) => {
    if (action.contextPaths.length > 0) {
      dispatch({ type: "SET_CONTEXT_FILES", paths: action.contextPaths });
    }
    if (action.promptTemplate) {
      dispatch({ type: "SET_PROMPT", prompt: action.promptTemplate });
    }
  }, []);

  const generate = useCallback(async () => {
    if (!state.prompt.trim()) return;
    dispatch({ type: "SET_ERROR", error: "" });
    dispatch({ type: "SET_STAGE", stage: "loading" });

    try {
      const res = await fetch("/api/workstation/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: state.prompt,
          contextPaths: state.contextFiles.length
            ? state.contextFiles
            : undefined,
        }),
      });

      if (!res.ok) {
        throw new Error(await getErrorMessage(res, "Generation failed"));
      }

      const data: GenerationResult = await res.json();
      dispatch({ type: "SET_RESULT", result: data });
    } catch (err) {
      dispatch({
        type: "SET_ERROR",
        error: err instanceof Error ? err.message : "Unknown error",
      });
      dispatch({ type: "SET_STAGE", stage: "input" });
    }
  }, [state.prompt, state.contextFiles]);

  const ask = useCallback(async () => {
    if (!state.prompt.trim()) return;
    dispatch({ type: "SET_ERROR", error: "" });
    dispatch({ type: "SET_STAGE", stage: "loading" });

    try {
      const res = await fetch("/api/workstation/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: state.prompt,
          contextPaths: state.contextFiles.length
            ? state.contextFiles
            : undefined,
        }),
      });

      if (!res.ok) {
        throw new Error(await getErrorMessage(res, "Failed to get answer"));
      }

      const data = await res.json();
      dispatch({
        type: "SET_QA_ANSWER",
        answer: data.answer,
        expert: data.expert,
        filesUsed: data.filesUsed,
      });
    } catch (err) {
      dispatch({
        type: "SET_ERROR",
        error: err instanceof Error ? err.message : "Unknown error",
      });
      dispatch({ type: "SET_STAGE", stage: "input" });
    }
  }, [state.prompt, state.contextFiles]);

  const research = useCallback(async () => {
    if (!state.researchInput.trim()) return;
    dispatch({ type: "SET_ERROR", error: "" });
    dispatch({ type: "SET_STAGE", stage: "loading" });

    // Auto-detect type: if it looks like a URL, treat as URL
    const input = state.researchInput.trim();
    const detectedType = /^https?:\/\//i.test(input) ? "url" : "text";

    try {
      // Submit to the backend agent queue
      const submitResult = await opsPost<{ ok: boolean; id: string }>(
        "/api/research",
        { content: input, type: detectedType }
      );

      if (!submitResult.ok) {
        throw new Error(submitResult.error);
      }

      const jobId = submitResult.data.id;
      dispatch({ type: "SET_RESEARCH_JOB_ID", jobId });

      // Poll until complete
      const maxAttempts = 120; // 120 * 3s = 6 min timeout
      for (let i = 0; i < maxAttempts; i++) {
        await new Promise((r) => setTimeout(r, 3000));

        const poll = await opsFetch<{
          status: "processing" | "completed" | "failed";
          result?: ResearchResult;
          error?: string;
        }>(`/api/research?id=${encodeURIComponent(jobId)}`);

        if (!poll) continue; // backend unreachable, keep trying

        if (poll.status === "completed" && poll.result) {
          dispatch({ type: "SET_RESEARCH_RESULT", result: poll.result });
          dispatch({ type: "SET_RESEARCH_JOB_ID", jobId: null });
          return;
        }

        if (poll.status === "failed") {
          throw new Error(poll.error || "Research analysis failed");
        }
        // status === "processing" → keep polling
      }

      throw new Error("Research timed out after 6 minutes");
    } catch (err) {
      dispatch({
        type: "SET_ERROR",
        error: err instanceof Error ? err.message : "Unknown error",
      });
      dispatch({ type: "SET_STAGE", stage: "input" });
      dispatch({ type: "SET_RESEARCH_JOB_ID", jobId: null });
    }
  }, [state.researchInput]);

  const iterate = useCallback(async () => {
    if (!state.iteratePrompt.trim() || !state.result) return;
    dispatch({ type: "SET_ERROR", error: "" });
    dispatch({ type: "SET_STAGE", stage: "loading" });

    try {
      const res = await fetch("/api/workstation/iterate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: state.iteratePrompt,
          originalPrompt: state.prompt,
          previousResponse: state.result,
        }),
      });

      if (!res.ok) {
        throw new Error(await getErrorMessage(res, "Iteration failed"));
      }

      const data: GenerationResult = await res.json();
      dispatch({ type: "SET_RESULT", result: data });
      dispatch({ type: "SET_ITERATE_PROMPT", prompt: "" });
    } catch (err) {
      dispatch({
        type: "SET_ERROR",
        error: err instanceof Error ? err.message : "Unknown error",
      });
      dispatch({ type: "SET_STAGE", stage: "review" });
    }
  }, [state.iteratePrompt, state.prompt, state.result]);

  const createPR = useCallback(async () => {
    if (!state.result) return;
    dispatch({ type: "SET_ERROR", error: "" });
    dispatch({ type: "SET_STAGE", stage: "creating-pr" });

    try {
      const res = await fetch("/api/workstation/create-pr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: state.result.files,
          commitMessage: state.commitMessage,
          prompt: state.prompt,
          reasoning: state.result.reasoning,
        }),
      });

      if (!res.ok) {
        throw new Error(await getErrorMessage(res, "PR creation failed"));
      }

      const data = await res.json();
      dispatch({ type: "SET_PR_URL", url: data.prUrl });
    } catch (err) {
      dispatch({
        type: "SET_ERROR",
        error: err instanceof Error ? err.message : "Unknown error",
      });
      dispatch({ type: "SET_STAGE", stage: "review" });
    }
  }, [state.result, state.commitMessage, state.prompt]);

  const discard = useCallback(() => {
    dispatch({ type: "RESET" });
  }, []);

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

  const bridgeToMode = useCallback(
    (mode: "qa" | "pr", contextPaths: string[], prompt: string) => {
      dispatch({ type: "BRIDGE_TO_MODE", mode, contextPaths, prompt });
    },
    []
  );

  const setActiveSpecSections = useCallback((sectionIds: string[], context: Record<string, SpecContextEntry[]> = {}) => {
    dispatch({ type: "SET_ACTIVE_SPEC_SECTIONS", sectionIds, context });
  }, []);

  const openDraftReview = useCallback(() => {
    dispatch({ type: "OPEN_DRAFT_REVIEW" });
  }, []);

  const closeDraftReview = useCallback(() => {
    dispatch({ type: "CLOSE_DRAFT_REVIEW" });
  }, []);

  const openDiscuss = useCallback((item: AgendaItem, initialPrompt?: string) => {
    dispatch({ type: "OPEN_DISCUSS", item, initialPrompt });
  }, []);

  const closeDiscuss = useCallback(() => {
    dispatch({ type: "CLOSE_DISCUSS" });
  }, []);

  const sendDiscussMessage = useCallback(
    async (text: string) => {
      if (!text.trim() || !state.discussItemId || !state.agendaData) return;

      // Find the current discuss item
      let discussItem: AgendaItem | null = null;
      for (const s of state.agendaData.sections) {
        const found = s.items.find((i) => i.id === state.discussItemId);
        if (found) { discussItem = found; break; }
      }
      if (!discussItem) return;

      // Add user message
      const userMsg: DiscussMessage = {
        id: `msg-${Date.now()}-user`,
        role: "user",
        content: text,
        timestamp: new Date().toISOString(),
      };
      dispatch({ type: "ADD_DISCUSS_MESSAGE", message: userMsg });
      dispatch({ type: "SET_DISCUSS_LOADING", loading: true });

      // Build prompt with conversation history
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

      // Build context paths
      const contextPaths: string[] = [];
      if (discussItem.source?.file) contextPaths.push(discussItem.source.file);
      if (discussItem.specRefs) {
        for (const ref of discussItem.specRefs) {
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

      // Check cache
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

  const submitProjections = useCallback(async () => {
    if (!state.agendaData?.specIndex) return;

    // Collect ready projections
    const readyProjections = Object.values(state.projections).filter(
      (p) => state.projectionStatus[p.sectionId] === "ready" || state.projectionStatus[p.sectionId] === "editing"
    );
    if (readyProjections.length === 0) return;

    // Mark all as submitting
    for (const p of readyProjections) {
      dispatch({ type: "SET_PROJECTION_STATUS", sectionId: p.sectionId, status: "submitting" });
    }

    try {
      // Fetch current SPEC.md
      const specRes = await fetch(
        `/api/workstation/file?path=${encodeURIComponent("spec/SPEC.md")}`
      );
      if (!specRes.ok) {
        throw new Error("Failed to fetch SPEC.md");
      }
      const specData = await specRes.json();
      const specLines = (specData.content as string).split("\n");

      // Sort projections by contentEnd descending (bottom-to-top splicing)
      const sorted = [...readyProjections].sort((a, b) => {
        const sA = state.agendaData!.specIndex!.sectionMap[a.sectionId];
        const sB = state.agendaData!.specIndex!.sectionMap[b.sectionId];
        return (sB.contentEnd ?? 0) - (sA.contentEnd ?? 0);
      });

      // Splice each projection into SPEC.md
      for (const proj of sorted) {
        const section = state.agendaData!.specIndex!.sectionMap[proj.sectionId];
        if (section.contentStart == null || section.contentEnd == null) continue;
        const newLines = proj.editedContent.split("\n");
        specLines.splice(section.contentStart, section.contentEnd - section.contentStart, ...newLines);
      }

      const newSpecContent = specLines.join("\n");

      // Find the source item for PR body
      let sourceItem: AgendaItem | null = null;
      for (const s of state.agendaData.sections) {
        const found = s.items.find((i) => i.id === state.projectionSourceItemId);
        if (found) { sourceItem = found; break; }
      }

      const res = await fetch("/api/workstation/create-pr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: [{ path: "spec/SPEC.md", content: newSpecContent, action: "update" }],
          commitMessage: state.projectionCommitMessage || "Update SPEC.md",
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
      // Reset statuses back to ready
      for (const p of readyProjections) {
        dispatch({ type: "SET_PROJECTION_STATUS", sectionId: p.sectionId, status: "ready" });
      }
      dispatch({
        type: "SET_ERROR",
        error: err instanceof Error ? err.message : "Failed to submit projections",
      });
    }
  }, [state.projections, state.projectionStatus, state.projectionCommitMessage, state.projectionSourceItemId, state.agendaData]);

  // Auto-fetch agenda when entering agenda mode with no cached data
  useEffect(() => {
    if (state.mode === "agenda" && !state.agendaData && !state.agendaLoading) {
      fetchAgenda();
    }
  }, [state.mode, state.agendaData, state.agendaLoading, fetchAgenda]);

  // Auto-send pending prompt when discuss opens with an initial action
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
    selectFile,
    addContextFile,
    removeContextFile,
    applyQuickAction,
    generate,
    ask,
    research,
    iterate,
    createPR,
    discard,
    fetchAgenda,
    openDraftReview,
    closeDraftReview,
    bridgeToMode,
    setActiveSpecSections,
    openDiscuss,
    closeDiscuss,
    sendDiscussMessage,
    requestProjection,
    updateProjectionEdit,
    submitProjections,
  };
}
