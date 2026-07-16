---
title: "ADR-011: Voice Edit Delta Feedback Loop"
description: "Close the voice feedback loop by having edit deltas directly influence profile building and draft generation"
---

# ADR-011: Voice Edit Delta Feedback Loop

**Date**: 2026-03-01
**Status**: Accepted
**Issue**: #21 (Voice edit delta feedback loop)

## Context

Edit deltas (`voice.edit_deltas`) were already captured every time Eric corrected a draft (D4: "most valuable table in the system"). However, these deltas were write-only data -- they informed the edit rate metric for L0 exit criteria but never fed back into profile building or draft generation. The system kept making the same mistakes Eric had already corrected: using "Dear" when he always changes it to "Hey", using formal closings he consistently replaces, etc.

The core gap: voice profiles were built solely from the sent email corpus (`voice.sent_emails`). Corrections to AI drafts -- which are the most direct signal of where the model diverges from Eric's preferences -- were ignored during profile construction and during prompt assembly.

## Decision

Close the feedback loop with two mechanisms:

1. **Profile corrections**: `analyzeEditDeltas()` reads the last 90 days of edits, extracts correction patterns (greetings, closings, vocabulary, formality), applies recency weighting, and `applyDeltaCorrections()` merges these into the base voice analysis before profile storage. Profiles now reflect both historical sent mail patterns AND explicit corrections to AI output.

2. **Prompt injection**: `getRecentEditExamples()` retrieves 2-3 high-magnitude original→edited snippet pairs and injects them as a PAST CORRECTIONS section into the responder prompt. This gives the LLM concrete in-context examples of what Eric changed, complementing the statistical profile with specific instances.

The "why": edit deltas are the highest-signal data the system has about where AI drafts diverge from Eric's voice. Leaving them as passive metrics wastes the most valuable feedback signal. Closing the loop lets the system self-correct without manual profile tuning.

`getRecentEditExamples()` uses a 90-day recency window rather than the `AI_PIPELINE_CUTOFF` used by few-shot-selector.js. Edit deltas are human corrections by definition, so every edit is a valid training signal regardless of when it was created. The magnitude threshold (>= 0.1) filters out trivial edits.

Auto-rebuild is triggered after 5 accumulated edits (threshold balances responsiveness vs. rebuild cost). A module-level in-flight guard prevents concurrent rebuilds. Manual rebuild is available via API and CLI for immediate application.

## Alternatives Considered

| Alternative | Pros | Cons | Why Rejected |
|-------------|------|------|--------------|
| Manual-only profile tuning | Full human control; no risk of feedback loops | Doesn't scale; Eric would need to hand-edit profile JSON; corrections are already captured but ignored | Wastes the D4 data; defeats the purpose of an autonomous system |
| Periodic batch rebuild without prompt injection | Simpler; profiles improve but no prompt changes | Slower convergence; LLM doesn't see specific corrections, only aggregate shifts; misses the most instructive signal (exact edit pairs) | Prompt injection provides the fastest per-draft improvement; profiles alone only shift aggregate tendencies |
| Full fine-tuning on edit pairs | Strongest model-level learning; changes persist across all prompts | Requires Anthropic fine-tuning API (not available for Haiku); expensive; overkill for per-user voice matching; irreversible | Not available today; contradicts P4 (boring infrastructure); in-context learning is sufficient for the current scale |

## Consequences

**Positive:**
- Profiles converge toward Eric's actual preferences without manual intervention
- The responder immediately sees specific corrections, reducing repeat mistakes
- Auto-rebuild keeps profiles fresh as corrections accumulate
- The API bug fix (`POST /api/drafts/edit` now calls `recordEditDelta()` properly) means all edits are tracked with correct classification and magnitude

**Negative:**
- Feedback loop risk: if vocabulary override detection is too noisy, the system could amplify content-level changes as vocabulary preferences (mitigated: 2+ occurrence threshold)
- Auto-rebuild adds async DB work after edits (mitigated: fire-and-forget, non-blocking, in-flight guard prevents concurrent rebuilds)
- Recency weighting assumptions (90-day window, linear decay) may not be optimal for all correction patterns

**Neutral:**
- The PAST CORRECTIONS prompt section adds ~200-400 tokens per draft request (within Haiku's context budget)
- The global profile DELETE+INSERT is wrapped in a transaction to prevent data loss on crash

## Affected Files

- `src/voice/profile-builder.js` -- `analyzeEditDeltas()`, `applyDeltaCorrections()`, `shouldRebuild()`, `rebuildAllProfiles()`; both `buildGlobalProfile()` and `buildRecipientProfiles()` now call these
- `src/voice/edit-tracker.js` -- `getRecentEditExamples()` for prompt injection; `recordEditDelta()` now triggers auto-rebuild check
- `src/agents/executor-responder.js` -- PAST CORRECTIONS prompt section added to both email and Slack prompts
- `src/api.js` -- `POST /api/voice/rebuild` endpoint; `POST /api/drafts/edit` bug fix (now calls `recordEditDelta()` instead of inline SQL)
- `src/cli/commands/voice.js` -- `voice rebuild` subcommand

## Cross-Project Impact

None. The feedback loop is internal to autobot-inbox's voice system. The spec (`autobot-spec/SPEC.md`) describes edit deltas as training data (D4); this ADR implements the training mechanism. No changes needed in autobot-spec or the dashboard.
