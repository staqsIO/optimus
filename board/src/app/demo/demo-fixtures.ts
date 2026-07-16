import type { Draft } from "@/components/inbox/QueueItem";
import type { PipelineTimelinePayload } from "@/components/inbox/PipelineReplay";

/** Synthetic IDs — never collide with UUIDs from the inbox API. */
export const DEMO_MESSAGE_PREFIX = "demo-msg-";

export const DEMO_EMAIL_BODY = `Hi Alex,

Following up on the Q2 roadmap review — can you confirm whether we're still targeting the April 15 handoff for the API hardening milestone? Legal asked for a firm date for the customer comms draft.

Thanks,
Jordan`;

export const DEMO_KB_CHUNKS = [
  {
    text: "Roadmap reviews should surface milestone dates and dependencies explicitly. Escalate if legal needs customer-facing copy before engineering sign-off.",
    similarity: 0.82,
    documentId: "demo-doc-roadmap-policy",
    metadata: { title: "Internal: release communication checklist", source: "demo" },
  },
  {
    text: "Tone: concise, warm, no over-promising on dates. Prefer 'targeting' over 'committed' unless G6 cleared.",
    similarity: 0.71,
    documentId: "demo-doc-voice-notes",
    metadata: { title: "Voice profile — board replies", source: "demo" },
  },
];

/** Matches GET /api/pipeline/timeline shape; entirely fictional. */
export const DEMO_PIPELINE_TIMELINE: PipelineTimelinePayload = {
  message: {
    id: `${DEMO_MESSAGE_PREFIX}0001`,
    received_at: "2026-04-02T14:22:00.000Z",
    triage_category: "action_required" as const,
    processed_at: "2026-04-02T14:23:18.000Z",
    work_item_id: "demo-wi-0001",
    priority_score: 72,
  },
  work_item: {
    id: "demo-wi-0001",
    status: "review",
    type: "task" as const,
    assigned_to: "agent-responder-demo",
    title: "Draft reply: Q2 roadmap date confirmation",
    created_at: "2026-04-02T14:23:20.000Z",
  },
  transitions: [
    {
      from_state: "created",
      to_state: "assigned",
      agent_id: "agent-orchestrator-demo",
      reason: "Routed from triage",
      created_at: "2026-04-02T14:23:21.000Z",
    },
    {
      from_state: "assigned",
      to_state: "in_progress",
      agent_id: "agent-responder-demo",
      reason: null,
      created_at: "2026-04-02T14:23:45.000Z",
    },
    {
      from_state: "in_progress",
      to_state: "review",
      agent_id: "agent-responder-demo",
      reason: "Draft ready for board",
      created_at: "2026-04-02T14:25:02.000Z",
    },
  ],
  drafts: [
    {
      id: "demo-draft-0001",
      created_at: "2026-04-02T14:25:00.000Z",
      reviewer_verdict: "approved" as const,
      board_action: null,
      send_state: "pending",
      tone_score: 0.87,
      email_summary: "Confirm April 15 API hardening handoff or propose a revised date; keep legal in the loop.",
    },
  ],
};

export const DEMO_DRAFT: Draft = {
  id: "demo-draft-0001",
  body: `Hi Jordan,

Thanks for flagging this. We're still targeting April 15 for the API hardening handoff on the engineering side. I'll sync with Legal this afternoon on the customer comms timeline and reply with a firm date they can use — if anything shifts, I'll send an updated note before end of day.

Best,
Alex`,
  message_id: `${DEMO_MESSAGE_PREFIX}0001`,
  tone_score: 0.87,
  reviewer_verdict: "approved",
  reviewer_notes: null,
  gate_results: {
    G1: { passed: true },
    G2: { passed: true },
    G3: { passed: true },
    G4: { passed: true },
    G5: { passed: true },
    G6: { passed: true },
    G7: { passed: true },
  },
  created_at: "2026-04-02T14:25:00.000Z",
  email_summary:
    "They want a confirmed date for the Q2 milestone and legal-ready customer messaging.",
  draft_intent:
    "Confirm engineering target, commit to a Legal follow-up today, avoid over-promising.",
  channel: "email",
  confidence_tier: "high",
  version: 1,
  emails: {
    from_address: "jordan.morgan@example.com",
    from_name: "Jordan Morgan",
    subject: "Re: Q2 roadmap — date for Legal",
    triage_category: "action_required",
    snippet: "Following up on the Q2 roadmap review — can you confirm whether we're still targeting...",
    received_at: "2026-04-02T14:22:00.000Z",
    priority_score: 72,
    channel: "email",
    account_label: null,
  },
};
