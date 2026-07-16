export interface UploadedFile {
  id: string;
  name: string;
  mimeType: string;
  base64: string;
  size: number;
}

export interface TreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: TreeNode[];
}

export interface FileContent {
  path: string;
  content: string;
  size: number;
}

export interface FileChange {
  path: string;
  content: string;
  action: "create" | "update";
}

export interface GenerationResult {
  reasoning: string;
  commitMessage: string;
  files: FileChange[];
  username?: string;
}

export type SpecDomain = "foundations" | "runtime" | "infrastructure" | "governance" | "strategy";
export type SpecStatus = "stable" | "active" | "under-review" | "recently-updated" | "has-proposal";

export interface SpecSection {
  id: string;        // "0", "14", "14.1"
  heading: string;   // "Design Principles"
  level: 2 | 3;     // ## = 2, ### = 3
  content: string;   // raw markdown between this heading and the next
  file?: string;     // per-section filename, e.g. "00-design-principles.md"
  domain?: SpecDomain;
  status?: SpecStatus;
  phase?: number;
  headingLine?: number;   // 0-indexed line of the ## heading in SPEC.md (legacy)
  contentStart?: number;  // first line of content after heading (legacy)
  contentEnd?: number;    // line after last line of content (legacy)
}

export interface SpecDomainInfo {
  id: SpecDomain;
  color: string;     // tailwind color token: "zinc", "blue", "teal", "amber", "purple"
  label: string;     // "Foundations", "Runtime", etc.
}

export interface SpecDomainGroup {
  domain: SpecDomainInfo;
  sections: SpecSection[];
}

export interface SpecIndex {
  version: string;
  sections: SpecSection[];
  sectionMap: Record<string, SpecSection>;  // keyed by id for O(1) lookup
}

export interface SpecRef {
  sectionId: string;  // "13"
  raw: string;        // "§13 component table"
}

export interface DiscussMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  expert?: string;
  filesUsed?: string[];
}

export interface SpecContextEntry {
  title: string;
  file: string;
}

export interface DiffLine {
  type: "equal" | "add" | "remove";
  content: string;
  oldLineNo?: number;
  newLineNo?: number;
}

export interface SpecProjection {
  sectionId: string;
  originalContent: string;
  projectedContent: string;
  editedContent: string;
  diff: DiffLine[];
  sourceItemId: string;
  sourceItemTitle: string;
  contentHash: string;
}

export type ProjectionStatus = "idle" | "loading" | "ready" | "editing" | "submitting";

export type Stage = "input" | "loading" | "review" | "creating-pr" | "done" | "qa-response" | "research-results";

export type Mode = "pr" | "qa" | "agenda" | "feed" | "research";

export interface GapItem {
  id: string;
  title: string;
  description: string;
  specSection?: string;
  suggestedAction?: string;
}

export interface ResearchResult {
  summary: string;
  gaps: GapItem[];
  alreadyCovered: string[];
  notApplicable: string[];
  sourceType: "url" | "text";
  sourceContent: string;
}

export interface QuickAction {
  id: string;
  label: string;
  icon: string;
  contextPaths: string[];
  promptTemplate: string;
}

// --- Feed Card Types (Phase 1) ---

export type CardType = "change" | "answer" | "research" | "intake" | "build";
export type CommandChip = "change" | "ask" | "research" | "agenda" | "intake" | "build" | "content" | "contract";

export type FeedCard = {
  id: string;
  type: CardType;
  createdAt: number;
  input: string;
  contextFiles: string[];
} & (
  | {
      type: "change";
      stage: "loading" | "preview" | "iterating" | "creating-pr" | "done";
      result?: GenerationResult;
      commitMessage?: string;
      prUrl?: string;
      reasoning?: string;
      iteratePrompt?: string;
      error?: string;
    }
  | {
      type: "answer";
      stage: "loading" | "answered";
      answer?: string;
      expert?: string;
      filesUsed?: string[];
      error?: string;
      action?: {
        type: string;
        workItemId?: string;
        assignedTo?: string;
        title?: string;
        linearUrl?: string;
      };
    }
  | {
      type: "research";
      stage: "loading" | "analyzing" | "done";
      result?: ResearchResult;
      jobId?: string;
      error?: string;
    }
  | {
      type: "intake";
      stage: "submitting" | "submitted" | "classified";
      submissionId?: string;
      classification?: string;
      error?: string;
    }
  | {
      type: "build";
      stage: "submitting" | "submitted" | "in_progress" | "completed" | "failed";
      campaignId?: string;
      iterations?: number;
      maxIterations?: number;
      spentUsd?: number;
      bestScore?: number | null;
      error?: string;
    }
);

export interface AgendaAction {
  label: string;
  mode: "qa" | "pr";
  contextPaths: string[];
  promptTemplate: string;
}

export interface AgendaItem {
  id: string;
  category: "pending-review" | "open-question" | "spec-patch" | "deferred" | "research" | "decision" | "strategic-decision" | "operational-stat";
  title: string;
  summary: string;
  priority: "high" | "medium" | "low";
  source: { file: string; section?: string };
  metadata: Record<string, string>;
  actions: AgendaAction[];
  content?: string;
  specRefs?: SpecRef[];
}

export interface AgendaSection {
  id: string;
  title: string;
  description: string;
  items: AgendaItem[];
}

export interface AgendaData {
  sections: AgendaSection[];
  specIndex: SpecIndex | null;
  fetchedAt: string;
  errors: { source: string; message: string }[];
}

// --- Spec Proposals (Phase 4: Bidirectional Edit Flow) ---

export interface SpecProposalSection {
  sectionId: string;
  file?: string;
  proposedContent: string;
  reasoning: string;
}

export interface SpecProposal {
  id: string;
  agent_tier: string;
  agent_name?: string;
  work_item_id?: string;
  title: string;
  summary: string;
  sections: SpecProposalSection[];
  status: "pending" | "approved" | "rejected" | "revision-requested" | "superseded";
  board_feedback?: string;
  revision_of?: string;
  created_at: string;
  reviewed_at?: string;
  reviewed_by?: string;
}

export type ProposalAction = "approved" | "rejected" | "revision-requested";

// --- Agent Intents (§14 Intent System) ---

export interface AgentIntent {
  id: string;
  agent_id: string;
  agent_tier: string;
  intent_type: string;
  decision_tier: "existential" | "strategic" | "tactical";
  title: string;
  reasoning: string;
  proposed_action: {
    type: string;
    payload?: Record<string, unknown>;
  };
  trigger_context: Record<string, unknown> | null;
  status: "pending" | "approved" | "rejected" | "executed" | "expired";
  board_feedback: string | null;
  expires_at: string | null;
  created_at: string;
}

export interface IntentMatchRate {
  agent_id: string;
  intent_type: string;
  approved: number;
  rejected: number;
  total: number;
  match_rate: number;
}

export interface GovernanceFeedItem {
  id: string;
  feed_type: "draft_review" | "strategic_decision" | "budget_warning" | "blocked_item" | "event" | "agent_intent" | "intent_executed" | "learning_insight";
  title: string;
  summary: string;
  created_at: string;
  metadata: Record<string, unknown>;
  priority: number;
  requires_action: boolean;
  board_relevance: number;
}

export interface AgentCapability {
  agent_id: string;
  agent_type: string;
  model: string;
  is_active: boolean;
  active_tasks: number;
  completed_7d: number;
  failed_7d: number;
  can_delegate_to: string[] | null;
}

export interface GovernanceSummary {
  attention_needed: number;
  narrative: string;
  budget: { spent: number; allocated: number; pct: number };
  gates: { passing: number; total: number };
  drafts_pending: number;
  strategic_pending: number;
  intents_pending: number;
  pipeline_active: number;
}

// --- Autonomy Controls Types ---

export interface AutonomyAgent {
  agent_id: string;
  agent_type: string;
  model: string;
  is_active: boolean;
  current_level: number;
  promoted_at: string | null;
  promoted_by: string | null;
}

export interface AutonomyCriterion {
  required: number | boolean;
  actual: number | boolean | null;
  met: boolean;
  note?: string | null;
}

export interface AutonomyEvaluation {
  currentLevel: number;
  evaluatedAt: string;
  exitCriteria: {
    met: boolean;
    criteria: Record<string, AutonomyCriterion>;
    recommendation: string;
  };
}

export interface AutonomyPromotion {
  agent_id: string;
  from_level: number;
  to_level: number;
  promoted_by: string;
  notes: string | null;
  criteria_snapshot: Record<string, AutonomyCriterion>;
  created_at: string;
}

export interface AutonomyData {
  agents: AutonomyAgent[];
  evaluation: AutonomyEvaluation | null;
  history: AutonomyPromotion[];
}

// --- Pipeline Health Types ---

export interface AgentQueue {
  agent_id: string;
  created: number;
  assigned: number;
  in_progress: number;
  in_review: number;
  blocked: number;
  total_active: number;
}

export interface StuckItem {
  id: string;
  title: string;
  type: string;
  status: string;
  assigned_to: string;
  retry_count: number;
  created_at: string;
  updated_at: string;
  minutes_since_update: number;
  // Campaign context (null for non-campaign work items)
  campaign_id: string | null;
  campaign_status: string | null;
  campaign_iterations: string | null; // "3/10" format
}

export interface BoardCommand {
  id: string;
  title: string;
  type: string;
  status: string;
  assigned_to: string;
  created_at: string;
  updated_at: string;
  source: string;
}

export interface ThroughputBucket {
  bucket: string;
  completed: number;
}

export interface PipelineHealthData {
  queues: AgentQueue[];
  stuck: StuckItem[];
  boardCommands: BoardCommand[];
}

export interface ThroughputData {
  buckets: ThroughputBucket[];
  total_24h: number;
}

// --- Agent Work Feed Types (Visual Agent Completions) ---

export interface AgentWorkCompletion {
  id: string;
  title: string;
  type: string;
  agent: string;
  status: string;
  sourceUrl: string | null;
  projectName: string | null;
  costUsd: number | null;
  hasPreview: boolean;
  completedAt: string;
  completionReason: string | null;
  createdAt: string;
  // Campaign-specific (null for non-campaign work)
  campaignId: string | null;
  campaignStatus: string | null;
  campaignGoal: string | null;
  campaignIterations: number | null;
  campaignSpentUsd: number | null;
  campaignBestScore: number | null;
}

export interface AgentWorkInProgress {
  id: string;
  title: string;
  type: string;
  agent: string;
  status: string;
  sourceUrl: string | null;
  projectName: string | null;
  createdAt: string;
  updatedAt: string;
  // Campaign-specific (null for non-campaign work)
  campaignId: string | null;
  campaignGoal: string | null;
  campaignIterations: number | null;
  campaignMaxIterations: number | null;
  campaignSpentUsd: number | null;
  campaignBudgetUsd: number | null;
}

export interface AgentWorkData {
  completions: AgentWorkCompletion[];
  inProgress: AgentWorkInProgress[];
}
