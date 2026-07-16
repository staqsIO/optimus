# LinkedIn Content Automation: Dustin's Use Case

**Date:** 2026-03-01
**Participants:** Eric (human), Claude (Liotta + Linus agents)
**Status:** Accepted -- proceeding to implementation as Phase 1.5
**References:** ADR-002 (individual install), linkedin-channel-analysis.md, Dustin's LinkedIn Voice Guide

---

## Context

Following the LinkedIn channel analysis (which focused on Bennett's recruiting use case), Dustin responded: "Its aligned with the .MD I have as the base for my LinkedIn Claude project folder. My biggest issue is execution. I'm so burnt out on social media. If we could automate it without it being shit, I'd be all in."

Dustin shared his existing LinkedIn Writing Agent voice guide -- a 465-line document he uses as a Claude project file to manually write LinkedIn posts. The question: can AutoBot automate his content pipeline using the existing architecture?

## Dustin's Voice Guide (Summary)

Dustin already has the hardest part solved -- a detailed, battle-tested voice specification:

**Identity:** Founder-operator in CPG manufacturing. Krunchy Kids (Amazon snack brand), gummy/chocolate manufacturing, EAG (fractional C-suite), CDE Ingredients, Mycosymbiotics, MycoFest, 40-acre permaculture operation.

**Voice:** Calm experienced operator, thinking in public not performing, speaking to peers not an audience, grounded in operational reality. Occasionally playful, never motivational.

**Hard constraints (infrastructure-enforced):**
- No em dashes
- No "It's not X, it's Y" constructions or contrastive reframes
- No bullet points in posts (unless listing concrete data)
- No motivational/hype language
- 15+ forbidden words: "game changer", "unlock", "journey", "leverage", etc.
- Minimal formatting (no bold, no headers, no numbered lists)

**Content structure:** Grounded opening observation, operational insight with economics, implication for operators, quiet closing line.

**Topic areas:** CPG manufacturing ops, low MOQ positioning, co-packing economics, Amazon marketplace, AI tools for operations, permaculture, mushroom research.

**Quality bar:** 12-point checklist including "Would a peer write this?", "Could this appear in a VC content playbook? (If yes, rewrite)", "Every sentence carries information."

**Reference corpus:** 4 annotated example posts with explicit "why this works" breakdowns.

## Agent Analysis

### Liotta (Contrarian Leverage / Strategy)

**Core thesis:** Dustin has already solved the hardest problem in content automation and doesn't realize it. His voice guide IS the constitutional layer. His checklist IS the gate system. His annotated posts ARE the few-shot corpus. The bottleneck is purely execution, not quality.

**Key findings:**

1. **The 10x insight is architecture reuse, not a scheduling tool.** The AutoBot voice+gate pipeline maps nearly 1:1 to content generation. `voice/embeddings.js` for tone matching, `reviewer.js` patterns for gate enforcement, `guard-check.js` for budget/rate limiting. Reuse is north of 70%.

2. **The manual bottleneck is not posting (step 6). It's topic generation when burnt out (step 1) and the iteration loop with Claude (steps 3-4).** Scheduling tools solve the wrong problem entirely.

3. **Topic generation is a constraint satisfaction problem.** Six topic areas, recent business activity (extractable from email if he runs AutoBot-Inbox), freshness constraint (don't repeat within N days). Trivially small search space.

4. **This is the cheapest possible test of the generalization thesis.** The entire Optimus architecture claims that voice+gate+task-graph generalizes beyond email. Dustin's use case tests that with: no cold-start problem (voice guide exists), no partnership problem (self-service API), no onboarding problem (co-founder), simple success metric (posts per week).

5. **Co-founder burnout is an existential risk.** 580 LOC of new code to retain an active co-founder who is already aligned with the architecture is the highest-leverage engineering investment available.

### Linus (Architecture / Code Quality)

**Core thesis:** The proposal is sound. The architecture supports it without fundamental changes. The hardest part is voice enforcement for generated content, and Dustin's 465-line guide is a massive advantage.

**Key findings:**

1. **The existing pipeline cannot handle content generation directly.** Every agent is hardwired for reactive flow: orchestrator polls Gmail, responder requires `context.email`, reviewer loads `context.email`. Content generation has no inbound trigger. New agents are needed, but they plug into the same `AgentLoop`, `state-machine`, and `guard-check`.

2. **Do NOT reuse the voice profile builder.** `profile-builder.js` analyzes email greetings, closings, formality markers. LinkedIn content has none of these. The voice guide IS the profile -- use it as the system prompt. The 4 annotated posts are the few-shots. Different problems, different solutions.

3. **Hard constraints become regex gates (P2).** Forbidden words, em-dash ban, bullet point ban -- these are deterministic checks identical to G2/G7 patterns. Infrastructure enforces; the soft voice guidance stays in the prompt.

4. **Constitutional gates need content-specific adjustments:**
   - G1 (budget): Applies as-is
   - G2 (commitment language): Applies, more critical for public posts
   - G3 (voice match): Match against embedded reference posts, not sent emails
   - G5 (reversibility): LinkedIn posts are deletable but effectively permanent once in feeds/caches. Higher risk profile than email drafts. Tier 3 (Reputational, human-in-the-loop) via the gateway.
   - G6 (rate limit): Reparameterize for posts/day and posts/week instead of emails/recipient/day
   - G7 (precedent): Applies -- CPG economics posts may disclose pricing

5. **New gate needed: G8 (Factual Accuracy).** Content generation can hallucinate industry statistics. When Dustin writes about specific economics, a gate should flag numeric claims, regulatory references, and named company claims for human verification.

6. **Critical implementation detail:** `src/index.js` hardcodes agent imports. Dustin's instance needs config-driven agent selection. Without this, ADR-002 doesn't work in practice.

7. **New `content` schema recommended** -- clean separation from inbox:
   - `content.topics` (topic queue with scheduling)
   - `content.drafts` (structurally similar to `inbox.drafts`, with gate results and tone scores)
   - `content.reference_posts` (Dustin's 4 annotated examples, embedded via pgvector)

### Where They Agree

- Pull forward from Phase 6 to Phase 1.5
- Three new agents (~550-700 LOC total), same runtime infrastructure
- Do NOT generalize the email voice system -- keep domain logic separate, share infrastructure
- Hard constraints as infrastructure gates, soft guidance in prompts (P2)
- L0 approval gates (nothing posts without Dustin's explicit approval) means near-zero blast radius
- The edit delta feedback loop (Dustin's edits to drafts) is the training signal for improvement

### Where They Disagree

**Schema approach:** Linus wants a dedicated `content` schema. Liotta suggests reusing existing tables with metadata. Resolution: follow Linus -- clean schema separation prevents content data from polluting inbox metrics and vice versa.

**G8 gate:** Linus proposes a new Factual Accuracy gate for content generation. Liotta doesn't mention it. Resolution: adopt it -- Dustin writes about specific CPG economics, and hallucinated numbers in public posts are a real risk.

## Decision: Phase 1.5 Content Agent

### Architecture

Dustin's own AutoBot instance (ADR-002), running content agents instead of (or alongside) email agents:

```
Dustin's AutoBot Instance
  |
  +-- Content Orchestrator (schedule/directive-driven, NOT Gmail polling)
  |     Creates content_generation work items from topic queue
  |
  +-- Content Generator (voice guide as system prompt, reference posts as few-shots)
  |     Drafts post, stores in content.drafts
  |
  +-- Content Reviewer (G2, G3-adjusted, G5-adjusted, G6-adjusted, G7, G8-new, hard constraints)
  |     Routes approved drafts to gateway as Tier 3
  |
  +-- Gateway → LinkedIn poster (w_member_social API) OR clipboard fallback
```

### New Code

| Component | LOC | What it does |
|---|---|---|
| `src/agents/content-orchestrator.js` | ~150 | Schedule/directive-driven topic queue processing |
| `src/agents/content-generator.js` | ~200 | Voice-matched draft generation with few-shot examples |
| `src/agents/content-reviewer.js` | ~150 | Gate checks (G2, G3, G5, G6, G7, G8, hard constraints) |
| `src/linkedin/poster.js` | ~80 | Thin LinkedIn API client (w_member_social OAuth) |
| `config/content-gates.json` | ~50 | Dustin's hard constraints as gate configuration |
| SQL migration | ~30 | content schema (topics, drafts, reference_posts) |
| Config-driven agent selection in index.js | ~20 | Make ADR-002 actually work |

**Total new:** ~680 LOC + migration
**Reused unchanged:** AgentLoop, state-machine, guard-check, constitutional-engine, embeddings, gateway, event-bus, db (~2,000+ LOC)

### Revised Build Order

| Phase | What | Status |
|---|---|---|
| **1** | Eric's inbox pipeline (5 agents, constitutional gates, voice system) | In progress |
| **1.5** | Dustin's instance + content agent (3 new agents, content schema, LinkedIn API) | New |
| **2** | Repeatable install process (ADR-002 docs + setup script) | Revised |
| **3** | Goal-directed work items (directives via CLI/dashboard) | Unchanged |
| **4** | Outbound pipeline (recruiting for Bennett) | Unchanged |

### Success Criteria

| Metric | Baseline (burnt out) | Target | Timeline |
|---|---|---|---|
| Posts per week | 0-1 | 3-4 consistently | Month 1-2 |
| Dustin's time per post | ~60 min manual | <5 min (review + approve) | Month 1 |
| Draft approval rate (no edits) | N/A | >=60% | Week 2-4 |
| Voice gate catch rate | N/A | 100% of hard constraint violations | Week 1 |
| LLM cost per post | ~$0.02-0.05 (Claude project) | <$0.10 | Ongoing |
| Consistency gap (max days between posts) | 3-45 days | <3 days | Month 2 |

### Risk Assessment

1. **Voice drift** -- Mitigated by edit delta feedback loop (same pattern as inbox) + deterministic hard constraint gates
2. **LinkedIn API changes** -- Fallback is clipboard output. Voice/gate infrastructure works regardless of output channel.
3. **Topic staleness** -- Degrades gracefully to voice guide topic areas with recency constraint. Improves if Dustin runs email pipeline (signal extraction feeds topics).

---

*Next steps: Create GitHub issues for Phase 1.5 implementation tasks. Make `src/index.js` config-driven for agent selection. Stand up Dustin's instance.*
