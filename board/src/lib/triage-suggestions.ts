// FeedItem used to live under @/app/today/types when /today owned the Feed
// view. After /today was simplified the type only needed for these helpers,
// so it's co-located here.
export interface FeedItemActions {
  reviewer_verdict: string | null;
  board_action: string | null;
  github_issue_url: string | null;
  github_pr_url: string | null;
  linear_issue_url: string | null;
  draft_intent: string | null;
}

export interface FeedItemSignal {
  signal_type: string;
}

export interface FeedItem {
  triage_category: string | null;
  signals: FeedItemSignal[];
  actions: FeedItemActions[] | null;
  contact_type?: string | null;
  is_vip?: boolean | null;
}

/** One-line suggested next step for a signal type (obligations / feed). */
export function suggestedActionForSignalType(signalType: string): string {
  const map: Record<string, string> = {
    commitment: "Confirm or update",
    deadline: "Schedule or acknowledge",
    request: "Reply or delegate",
    question: "Answer in thread",
    approval_needed: "Approve or escalate",
    decision: "Decide and reply",
    introduction: "Introduce or decline",
    info: "Acknowledge or archive",
    action_item: "Complete or reassign",
  };
  return map[signalType] ?? "Review and respond";
}

function suggestedActionForTriage(triage: string | null | undefined): string {
  switch (triage) {
    case "action_required":
      return "Reply or delegate";
    case "needs_response":
      return "Draft a reply";
    case "fyi":
      return "Acknowledge or archive";
    case "noise":
      return "Archive";
    default:
      return "Triage";
  }
}

/** Prefer primary signal; fall back to triage when no signals. */
export function suggestedActionForFeedItem(item: FeedItem): string {
  const first = item.signals?.[0];
  if (first) return suggestedActionForSignalType(first.signal_type);
  return suggestedActionForTriage(item.triage_category);
}
