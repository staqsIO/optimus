/**
 * Synthesis prompt for engagement spec living-document generation.
 *
 * Builds the (system, user) pair fed to the LLM. The LLM is asked to
 * produce JSON describing the synthesized spec sections, any unresolved
 * conflicts between proposals, and any features removed since last synth.
 *
 * The prompt advises pin handling — but pin enforcement lives in synth.js
 * apply phase (P2: infrastructure enforces, prompts advise).
 */

export const CORE_SECTIONS = [
  { key: 'overview', title: 'Overview' },
  { key: 'scope', title: 'Scope' },
  { key: 'deliverables', title: 'Deliverables' },
  { key: 'stack', title: 'Stack' },
  { key: 'milestones', title: 'Milestones' },
  { key: 'risks', title: 'Risks' },
];

const SYSTEM_PROMPT_CLIENT = `You are a project scoping synthesizer. You are given:
- An engagement (a client project we are building software for).
- One or more PROPOSAL documents (drafts, finalized versions, notes) that describe what the client wants.
- The CURRENT SPEC sections, if any have been generated before.
- Notes on which sections were edited by a human (these are higher-signal than raw proposal text).
- Which sections are PINNED (treat their body as immutable — do not propose changes to their body).

Your job is to produce ONE living spec for this engagement, synthesizing the best ideas from every proposal. As more proposals arrive, the spec should get tighter — pick the strongest ideas, drop weak duplicates, surface real contradictions as conflicts rather than silently choosing.

Hard rules:
1. Always include these CORE sections in this order: Overview, Scope, Deliverables, Stack, Milestones, Risks.
2. You MAY add additional sections (Compliance, Integrations, Open Questions, etc.) when the proposals justify them. Place them after the core sections.
3. For PINNED sections, return the section in your output but DO NOT change its body. Copy the current body verbatim. (Infrastructure will skip your update anyway, but the audit is cleaner if you respect the pin.)
4. For sections marked "recently edited by human", treat the human's wording as authoritative unless an overwhelming new proposal contradicts it. When you do override a human edit, justify it in the section's provenance with a note like "Updated after human edit because finalized proposal X explicitly requires Y."
5. Finalized proposals outweigh drafts. Newer proposals outweigh older ones when they conflict, EXCEPT where the contradiction is significant (different tech stack, different payment provider, different scope) — those go in "conflicts" for a human to resolve, not silently picked.
6. Be specific. Don't write "modern stack" — name the framework. Don't write "industry-standard security" — name what the proposals call out.
7. Don't invent features that aren't in any proposal. If the proposals don't mention a feature, the spec doesn't include it.

You deliver your output by calling the \`emit_spec\` tool. Do NOT write prose, JSON, or anything else outside the tool call. The tool's input schema requires:

- \`sections\`: array of { key, title, body, ordinal, is_core, provenance: [proposal-id, ...] }. Core sections come first (ordinal 1-6), then any additional sections.
- \`conflicts\`: array of { summary, section_key?, options: [{ source_proposal_id?, text, rationale? }] }. Empty array if none.
- \`removed\`: array of { summary, rationale }. Empty array if nothing was dropped this pass.

Provenance is required on every section — list the proposal ids that informed it (empty array if a section is pure baseline carry-through).`;

const SYSTEM_PROMPT_MASTER_DISTILL = `You are a baseline-standards distiller. Your job is to produce the Master spec — a set of BASELINE standards that every future client engagement should inherit by default.

Unlike a per-engagement synth, your input is the existing CLIENT ENGAGEMENT SPECS already produced by this system, plus any MANUAL BASELINE PROPOSALS the user has attached directly to the Master. Your output is the patterns common across that body of work.

What "baseline" means:
- A line is baseline-worthy if it would apply to most future engagements of any kind, not just this client. Examples: "every engagement ships with a README and deployment runbook", "weekly client check-ins via 30-min call", "always include accessibility audit before launch", "default risks: third-party API availability, scope creep from late stakeholder feedback".
- A line is NOT baseline-worthy if it's specific to one engagement: a particular client name, a specific budget, a stack pick that was right for one project, a milestone tied to a specific launch date.

Hard rules:
1. Always include the CORE sections in this order: Overview, Scope, Deliverables, Stack, Milestones, Risks. Even if you have weak signal — a brief, conservative section is fine.
2. You MAY add additional sections (Communication Standards, Accessibility, Compliance, etc.) when patterns clearly justify them.
3. For PINNED sections, return the section but DO NOT change its body. Copy verbatim. Pins are how the human says "I've curated this — leave it alone."
4. For sections marked "recently edited by human", treat the human's wording as authoritative unless overwhelmingly contradicted by patterns across multiple engagements.
5. MANUAL BASELINE PROPOSALS (proposals attached directly to the Master) are authoritative — treat them as deliberate human-curated baselines and prefer their content over distilled patterns where they overlap.
6. Distill conservatively:
   - With many engagements (≥3): require a pattern to appear in at least 2 to count as baseline.
   - With few engagements (1-2): default to extracting only the strongest, most universal patterns. Be brief. It's fine for sections to be short or near-empty if there's no real signal.
   - Never invent baselines that aren't supported by either the manual proposals OR multiple engagement specs.
7. Strip engagement-specific details: client names, dollar amounts, specific launch dates, single-project stack choices. Generalize. ("Built with Next.js on Vercel" from one engagement is NOT a baseline; "team chooses framework based on client content-authoring needs" might be.)
8. The Overview section should describe what the Master spec IS (a standards document inherited by client engagements), not describe any single project.

You deliver your output by calling the \`emit_spec\` tool. Schema is identical to the client-engagement synth (sections / conflicts / removed). For provenance on each section, list the engagement ids and/or manual proposal ids that contributed.`;

/**
 * Build the user-message body containing engagement + proposals + current state.
 *
 * For non-master engagements, masterSections (when non-empty) is injected as
 * BASELINE STANDARDS the LLM should apply unless this engagement's proposals
 * say otherwise. The master itself never receives a baseline.
 */
function buildClientUserMessage({ engagement, proposals, sections, openConflicts, masterSections }) {
  const lines = [];
  lines.push(`ENGAGEMENT`);
  lines.push(`  name: ${engagement.name}`);
  lines.push(`  client: ${engagement.client || '(unspecified)'}`);
  lines.push(`  kind: ${engagement.kind}`);
  lines.push('');

  if (masterSections && masterSections.length > 0) {
    lines.push(`BASELINE STANDARDS (inherited from the Master spec). Apply these as defaults unless this engagement's proposals explicitly override them. Do NOT copy verbatim — adapt to this engagement's context. If a baseline conflicts with a proposal, the proposal wins (it is more specific).`);
    for (const ms of masterSections) {
      if (!ms.body) continue;
      lines.push('');
      lines.push(`### Baseline: ${ms.title}`);
      lines.push(ms.body);
    }
    lines.push('');
  }

  lines.push(`PROPOSALS (${proposals.length} total, in chronological order):`);
  for (const p of proposals) {
    lines.push('');
    lines.push(`--- proposal id=${p.id} kind=${p.kind} source=${p.source_type} created_at=${p.created_at} ---`);
    if (p.title) lines.push(`title: ${p.title}`);
    lines.push(p.parsed_markdown);
  }
  lines.push('');

  if (sections.length === 0) {
    lines.push(`CURRENT SPEC: (none — this is the first synthesis)`);
  } else {
    lines.push(`CURRENT SPEC (${sections.length} sections):`);
    for (const s of sections) {
      const human = s.last_human_edit_at
        ? ` (last edited by ${s.last_human_edit_by} at ${s.last_human_edit_at})`
        : '';
      const pin = s.pin_state === 'pinned' ? ' [PINNED — DO NOT CHANGE BODY]' : '';
      lines.push('');
      lines.push(`### ${s.title} [key=${s.section_key}, ordinal=${s.ordinal}]${pin}${human}`);
      lines.push(s.body || '(empty)');
    }
  }
  lines.push('');

  if (openConflicts.length > 0) {
    lines.push(`OPEN CONFLICTS (already surfaced, awaiting human resolution — do NOT re-raise these):`);
    for (const c of openConflicts) {
      lines.push(`  - ${c.summary}`);
    }
    lines.push('');
  }

  lines.push(`Synthesize the spec now by calling emit_spec.`);
  return lines.join('\n');
}

function buildMasterUserMessage({ proposals, sections, openConflicts, childSpecs }) {
  const lines = [];
  lines.push(`MASTER SPEC SYNTH`);
  lines.push(`  child engagements with synthesized specs: ${childSpecs.length}`);
  lines.push(`  manual baseline proposals attached to the master: ${proposals.length}`);
  lines.push('');

  if (childSpecs.length === 0) {
    lines.push(`(No child engagement specs exist yet — distill only from the manual baseline proposals below. With this little signal, be conservative.)`);
  } else {
    lines.push(`CLIENT ENGAGEMENT SPECS (distill baseline patterns from these — strip client-specific details):`);
    for (const cs of childSpecs) {
      lines.push('');
      lines.push(`=== engagement id=${cs.engagement.id} name="${cs.engagement.name}" client="${cs.engagement.client || '(unspecified)'}" kind=${cs.engagement.kind} ===`);
      if (cs.sections.length === 0) {
        lines.push(`  (no sections)`);
        continue;
      }
      for (const s of cs.sections) {
        lines.push('');
        lines.push(`### ${s.title} [${s.section_key}]`);
        lines.push(s.body || '(empty)');
      }
    }
    lines.push('');
  }

  if (proposals.length > 0) {
    lines.push(`MANUAL BASELINE PROPOSALS (authoritative — these are deliberate human-curated baselines, prefer them over distilled patterns where they overlap):`);
    for (const p of proposals) {
      lines.push('');
      lines.push(`--- proposal id=${p.id} kind=${p.kind} source=${p.source_type} ---`);
      if (p.title) lines.push(`title: ${p.title}`);
      lines.push(p.parsed_markdown);
    }
    lines.push('');
  }

  if (sections.length === 0) {
    lines.push(`CURRENT MASTER SPEC: (none — this is the first master synthesis)`);
  } else {
    lines.push(`CURRENT MASTER SPEC (${sections.length} sections):`);
    for (const s of sections) {
      const human = s.last_human_edit_at
        ? ` (last edited by ${s.last_human_edit_by} at ${s.last_human_edit_at})`
        : '';
      const pin = s.pin_state === 'pinned' ? ' [PINNED — DO NOT CHANGE BODY]' : '';
      lines.push('');
      lines.push(`### ${s.title} [key=${s.section_key}, ordinal=${s.ordinal}]${pin}${human}`);
      lines.push(s.body || '(empty)');
    }
  }
  lines.push('');

  if (openConflicts.length > 0) {
    lines.push(`OPEN CONFLICTS (do NOT re-raise these):`);
    for (const c of openConflicts) lines.push(`  - ${c.summary}`);
    lines.push('');
  }

  lines.push(`Distill the master spec now by calling emit_spec.`);
  return lines.join('\n');
}

export function buildSynthMessages({
  engagement,
  proposals,
  sections,
  openConflicts,
  masterSections = [],
  childSpecs = [],
}) {
  if (engagement.is_master) {
    return {
      system: SYSTEM_PROMPT_MASTER_DISTILL,
      user: buildMasterUserMessage({ proposals, sections, openConflicts, childSpecs }),
    };
  }
  return {
    system: SYSTEM_PROMPT_CLIENT,
    user: buildClientUserMessage({ engagement, proposals, sections, openConflicts, masterSections }),
  };
}
