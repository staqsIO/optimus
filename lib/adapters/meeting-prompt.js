/**
 * Meeting-extraction prompt template, shared across every meeting-shaped
 * webhook source (tl;dv, Gemini Meet, voice memos, future additions).
 *
 * Why centralized: the previous shape duplicated this prompt across three
 * entries in webhook-sources.json, which meant every refinement was three
 * find-and-replaces and one mistake away from drift. This file is the single
 * source of truth — webhook-adapter.js calls `buildMeetingHint(source)` and
 * the JSON entries no longer carry a channelHint for meeting sources.
 *
 * Variants:
 *   - Multi-speaker meetings (tl;dv, gemini): full coverage rules, direction
 *     attribution to other participants.
 *   - Single-speaker memos (voice_memo): self-note framing, "last third"
 *     coverage instruction since memos are short and topic-jumpy.
 */

const MULTI_SPEAKER_RULES = `This is NOT email. Override the email-specific classification heuristics — there is no single 'user' here, only multiple speakers in a recorded conversation. The system@autobot recipient is a placeholder; ignore it. Never classify as 'needs_response' or 'noise'. Use 'fyi' only if the meeting was purely social with zero actionable content.

DEFAULT AWAY FROM 'info'. The single most common classification failure on meeting transcripts is tagging plans, intents, suggestions, and stated future actions as 'info' when they should be 'action_item'. If a moment describes:
  - a plan ('we plan to X', 'they plan to deploy Y'),
  - an intent ('I'm going to', 'we want to'),
  - a suggestion ('we should X', 'maybe we could Y'),
  - a gap or unmet need ('the X doesn't work yet', 'we need a Y'),
  - a noticed problem someone is going to address,
→ that is action_item, commitment, or request — NEVER 'info'. Ask: 'will someone need to DO something for this to materialize?' If yes, name the doer and extract as action_item. Only use 'info' for inert background facts ('the Jetson board has 8GB RAM') with no human in the loop.

COVER THE WHOLE TRANSCRIPT. Working meetings rotate through multiple topic blocks (typically 5–10 minutes each); EACH block usually yields at least one action item. A 30-minute meeting commonly produces 5–12 items, an hour-long meeting 8–20.

SPEAKER DIVERSITY CHECK (mandatory before finalizing): Count the unique speakers in the transcript who spoke for more than ~30 cumulative seconds. Your output's obligors must include at least HALF of them. If a meeting has 5 substantive speakers and your output only names 1–2 of them as obligors, you have under-extracted from the others — go back and find what they took on.

The most common failure mode is over-attributing to the meeting lead while missing items from secondary speakers who only spoke up for one topic block (often in the second half of the meeting). Examples of patterns that indicate under-extraction:
  - Every action_item names the same person as obligor
  - Output covers one topic block in detail but ignores 2–3 other distinct topics that were discussed
  - Speakers who proposed something concrete ('I'll set up X', 'I can take Y') are missing as obligors

Skip jokes, asides, and casual check-ins ('can you hear me?'); extract everything else with a doable action and a named owner.

SIGNAL TYPES (action_item is the default — reach for it first):
- 'action_item' — someone agreed to do, said they would do, was asked to do, plans to do, or suggested doing something that got tacit agreement. INCLUDES: explicit assignments, soft commitments ('I'll take a look'), plans ('they plan to deploy X'), agreed-on suggestions ('we should add filtering' → 'yeah let's do that'), gaps someone owns. The person who will do it is the obligor (your best inference if not stated outright).
- 'commitment' — explicit verbal promise with a definite tone ('I'll send the deck tomorrow', 'we're locking in $50k for Q2').
- 'decision' — concrete decision reached or announced ('we're going with option B', 'deploying Friday').
- 'deadline' — date/timeframe; usually attach as dueDate on the related action_item rather than its own signal.
- 'request' — one participant asks another to do something after the meeting.
- 'info' — RARE. Inert background facts only.

CONTENT FORMAT — this is mandatory and the LLM gets it wrong unless told explicitly:

Every signal's \`content\` MUST use prescriptive third-person form. The verb pattern is:
  • '<Speaker> to <verb phrase> [by <when>]'
  • '<Speaker> committed to <verb phrase>'
  • '<Speaker> asked <other person> to <verb phrase>'

Past-tense descriptive verbs ('mentioned', 'discussed', 'sought', 'demonstrated', 'noted', 'shared', 'talked about') are FORBIDDEN. If you write 'X mentioned Y' you have classified incorrectly as info — re-read the moment and find the underlying action, then write it as 'X to <do that action>'.

GOOD (prescriptive, action-shaped):
  - 'Eric to deploy the on-premise version of VoiceRail next sprint.'
  - 'Dustin to improve knowledge base visibility for better debugging.'
  - 'Eric to update the Jetson setup so it can run the current build.'
  - 'Daniel to follow up with Eric on the script before EOD.'
  - 'Carlos to ship the day-override URL param to /today by Wednesday.'

BAD (descriptive, info-shaped — do NOT produce):
  - 'Eric Gang mentioned that the Jetson board cannot run the current setup' ← past-tense 'mentioned', should be 'Eric to update the Jetson setup...'
  - 'Eric Gang discussed plans to eventually deploy on-premise VoiceRail' ← 'discussed plans' → 'Eric to deploy on-premise VoiceRail next sprint'
  - 'Dustin Powers suggested improving the knowledge base visibility' ← 'suggested' → 'Dustin to improve KB visibility...'
  - 'Daniel Tovar sought clarification on the script' ← 'sought' → 'Daniel to follow up with Eric on the script' (or omit if resolved in-meeting)
  - 'Eric Gang: They're getting me a dev environment...' ← raw transcript quote

DIRECTION:
- speaker commits themselves → 'outbound'
- speaker asks another participant → 'inbound'
- shared → 'both'

STRUCTURED OUTPUT — required for meetings (overrides the default schema below):

You MUST organize the response around topic blocks. The transcript covers MULTIPLE distinct topics — do not consolidate them. Output a top-level \`topics\` array where each entry corresponds to one topic block discussed in the meeting:

  - title: short label naming the topic
  - speakers: array of attendees who substantively contributed to THIS topic (not the meeting overall)
  - signals: array of action_item / commitment / decision / request signals extracted from THIS topic block, using the signal schema below

Then ALSO include the top-level \`signals\` array containing every signal from every topic flattened together (the union of all topics[].signals — same content, just flat).

Why this matters: without explicit topic enumeration, you tend to elaborate the dominant topic in detail and skip the others entirely. Forcing one topic per array entry prevents that bias. Even if a topic has only one action item, it gets its own array entry.

Example shape:
{
  "category": "fyi",
  "topics": [
    {
      "title": "Formulate handoff to Isaias",
      "speakers": ["Eric Gang", "Isaias Valle"],
      "signals": [{ "type": "action_item", "content": "Eric to hand off Formulate cron jobs to Isaias.", "direction": "outbound", "confidence": 0.95, "domain": "general", "dueDate": null }]
    },
    {
      "title": "Voice assistant greeting fix",
      "speakers": ["Dustin Powers", "Daniel Tovar"],
      "signals": [{ "type": "action_item", "content": "Daniel to update the voice assistant greeting to ask 'how can I help you'.", "direction": "outbound", "confidence": 0.85, "domain": "general", "dueDate": null }]
    }
  ],
  "signals": [/* flattened union */]
}

A 30-minute meeting typically yields 4–8 topics. If your topics array has only 1–2 entries on a substantive transcript, you under-segmented — re-scan and split.

TOPIC DIVERSITY (mandatory): Your topics[] entries must cover DIFFERENT subject matters, not sub-divisions of the same topic. WRONG: ['Formulate handoff', 'Formulate cron jobs', 'Formulate pipeline', 'Formulate database'] — those are one topic. RIGHT: ['Formulate handoff to Isaias', 'Knowledge base / Gemini transcript ingestion', 'Voice assistant greeting', 'Customer demo prep']. If two of your topics share the same root subject (Formulate / Isaias / cron / staging), merge them and find the OTHER topics you missed.

TIME COVERAGE (mandatory): Your topics[] must collectively span the FULL meeting duration. The transcript has [MM:SS] timestamps; use them. If your last topic's content is from the first third of the meeting, scan the rest. Late-meeting topics matter as much as early ones — they often involve secondary speakers who only spoke up once.

TOPIC BOUNDARY HINTS — moments where speakers use any of these patterns are almost always new action items or topic boundaries:
  - 'I'll [verb]' / 'I can [verb]' / 'let me [verb]' / 'I'll take a look'
  - 'can you [verb]?' / '<Name>, can you [verb]?'
  - 'we should [verb]' / 'we need to [verb]' (especially if someone agrees: 'yeah let's do that')
  - 'okay, so [topic shift]' / 'speaking of [topic shift]'
  - Anyone named directly with a question or ask ('Carlos, when is X ready?', 'Dustin, can you Y?', 'Daniel, can we improve Z?')

Brief 1–2 minute exchanges where ONE speaker takes on a deliverable count as full topics — don't drop them just because they're concise. A 90-second 'Dustin asked Daniel to fix the greeting; Daniel agreed' moment is a topic.`;

const SINGLE_SPEAKER_RULES = `This is NOT email. Override the email-specific classification heuristics. Never classify as 'needs_response' or 'noise'.

The speaker is talking to themselves about things they want to do, decisions they're making, or context they want recorded. Treat first-person statements ('I need to', 'I'm going to', 'remember to') as commitments or action_items by the speaker, with direction='outbound'.

DEFAULT AWAY FROM 'info'. If the speaker mentions a need, a plan, an intent, or a noticed gap, that is an action_item or commitment — NOT info. Reserve 'info' for inert background context only.

COVER THE WHOLE MEMO. Voice memos often jump between several distinct topics in quick succession; each topic usually yields at least one action item. A 5-minute memo typically produces 3–8 signals, a 10-minute memo 6–15. Before finalizing: scan the LAST THIRD of the transcript — late-memo items are easy to miss because the speaker has already 'unloaded' on earlier topics.

CONTENT FORMAT: Each signal's \`content\` must be a SYNTHESIZED, third-person, single-sentence action item — NOT a transcript quote. Format: '<Speaker name or "Self"> to <verb phrase> [by <when>]'. Strip filler, capture the underlying action.

Signal types: action_item (default), commitment, decision, deadline, request, info (rare).`;

const MEETING_HEADERS = {
  tldv: 'MEETING TRANSCRIPT (tl;dv)',
  gemini: 'MEETING TRANSCRIPT (Gemini Meet)',
  voice_memo: 'VOICE MEMO transcript (single-speaker recording, often a self-note dictated by the user)',
};

const MEETING_SOURCES = new Set(Object.keys(MEETING_HEADERS));

/**
 * @param {string} source - webhook source name (e.g. 'tldv', 'gemini', 'voice_memo')
 * @returns {boolean} true if this source's prompt should be built from this template
 */
export function isMeetingSource(source) {
  return MEETING_SOURCES.has(source);
}

/**
 * Build the channelHint string for a meeting-shaped webhook source.
 * Returns null for non-meeting sources — caller should fall back to whatever
 * channelHint the source has in webhook-sources.json.
 *
 * @param {string} source
 * @returns {string|null}
 */
export function buildMeetingHint(source) {
  if (!MEETING_SOURCES.has(source)) return null;
  const header = MEETING_HEADERS[source];
  const rules = source === 'voice_memo' ? SINGLE_SPEAKER_RULES : MULTI_SPEAKER_RULES;
  return `CHANNEL: ${header}. ${rules}`;
}
