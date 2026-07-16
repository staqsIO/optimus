/**
 * Human-readable copy for constitutional gates and draft review UI.
 */

const GATE_SHORT: Record<string, string> = {
  G1: "Budget",
  G2: "Legal",
  G3: "Tone",
  G4: "Autonomy",
  G5: "Reversibility",
  G6: "Stakeholder",
  G7: "Precedent",
};

export const GATE_WHY: Record<string, string> = {
  G1: "Stays within the configured daily LLM budget.",
  G2: "No concerning commitment or legal language detected in the draft.",
  G3: "Tone matches your voice profile closely enough for outbound mail.",
  G4: "Autonomy level allows this kind of reply without escalation.",
  G5: "Reversible — draft in Gmail, not an irreversible send.",
  G6: "Stakeholder / rate limits respected for this channel.",
  G7: "No pricing, timeline, or policy precedent that needs extra review.",
};

export function gateWhy(gate: string): string {
  return GATE_WHY[gate] || `${GATE_SHORT[gate] || gate}: check passed or failed.`;
}
