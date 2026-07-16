# Unified Content Engine: Expanding Phase 1.5 from LinkedIn to Blog + LinkedIn

**Date:** 2026-04-12
**Participants:** Eric (human), Claude (Liotta + Linus agents)
**Status:** Accepted -- SPEC.md updated with Phase 1.5 section
**References:** conversation/archive/012-eric-linkedin-content-automation.md, Google Cloud ADK blog post (multi-agent content system)
**Supersedes:** Phase 1.5 scope as defined in conversation 012 (LinkedIn-only)

---

## Context

Dustin proposed building a blog for umbadvisors.com, inspired by Google's multi-agent content system using ADK + MCP (research agent, grounding agent, content generator, image generator, memory agent). The UMB Advisors site (Next.js 16, Vercel) is currently a single-page marketing site with no backend.

This triggered a re-evaluation of Phase 1.5, which was originally scoped as LinkedIn-only content automation for Dustin (conversation 012). The blog requirement overlaps significantly -- both need content generation, voice matching, content review gates, and output adapters.

**Key question:** Where should the blog generator live (Optimus, standalone, or hybrid), and how does it relate to the existing Phase 1.5 LinkedIn scope?

## Three-Perspective Analysis

### Liotta (Contrarian Architect)

**Verdict: Option C (Hybrid) -- 10x leverage.**

- Standalone in umbadvisors is dead on arrival -- rebuilding agent orchestration in a marketing site violates P4.
- Fully inside Optimus creates O(n) coupling -- every Optimus incident affects blog availability.
- Hybrid wins: Optimus generates content, pushes MDX to git, umbadvisors renders as static pages. Blog is CDN files -- 100% available during Optimus outages. Zero new infrastructure on the marketing site.
- Google ADK is "innovation theater" -- the multi-agent pattern is valuable, but ADK as a framework adds abstraction overhead when Optimus already has executor orchestration.

### Linus (Code Quality)

**Verdict: Put it in Optimus. Don't use ADK.**

- "Standalone is not simpler -- it's just complexity you haven't written yet."
- Vercel function timeouts (10-300s) would kill a multi-agent pipeline. Railway doesn't care.
- Google ADK is "marketing-driven engineering" -- Optimus already has an executor pattern.
- Coupling risk in Optimus is manageable: new executor, own schema, no cross-schema FKs.

### Synthesis

Both converge: generation lives in Optimus, delivery is static MDX to umbadvisors via git PRs. The blog post is the primary artifact; LinkedIn posts are a derived distribution format. This naturally unifies the original Phase 1.5 (LinkedIn) with the new blog requirement.

## Decision: Unified Content Engine (Phase 1.5 Expansion)

### What Changed from Original Phase 1.5

| Original Phase 1.5 (conversation 012) | Unified Phase 1.5 |
|---|---|
| LinkedIn posts only | Blog posts (primary) + LinkedIn posts (derived) |
| Dustin only | Multi-author (5 UMB Advisors partners) |
| 3 new agents (content-orchestrator, content-generator, content-reviewer) | 2 new agents (executor-writer with 5-phase pipeline, content-atomizer) + existing campaign system as orchestrator |
| LinkedIn API output only | Git-push PRs (blog) + LinkedIn API (LinkedIn) |
| Topic queue from email signals | 5-phase research pipeline (Reddit, web, RAG, grounding) |
| No image generation | AI-generated header images |

### What's Preserved

- `content` schema (topics, drafts, reference_posts) -- expanded with `content_type` column
- Dustin's 465-line voice guide for tone matching
- G8 (Factual Accuracy) gate
- Hard constraint gates (forbidden words, em-dash ban, etc.)
- L0 approval gates (nothing publishes without board approval)
- LinkedIn poster adapter (w_member_social OAuth)
- Edit delta feedback loop (board edits to drafts = training signal)

### Architecture

```
Campaign submit (Board UI or CLI)
  |
  v
Optimus claw-campaigner
  |
  v
executor-writer (5-phase pipeline)
  |-- Phase 1: Research (Reddit, HackerNews, web, forums)
  |-- Phase 2: Grounding (RAG knowledge base + authoritative sources)
  |-- Phase 3: Outline + Draft (MDX with frontmatter + SEO)
  |-- Phase 4: Image Generation (header infographic)
  |-- Phase 5: Memory + Learning (agent-memory.js + G11 retrospector)
  |
  v
Content gates (G7 content policy, G8 factual accuracy, hard constraints)
  |
  +---> Git PR to umbadvisors repo (blog MDX)
  |       Board member reviews + approves PR
  |       Merge triggers Vercel rebuild (static CDN)
  |
  +---> content-atomizer (blog -> 1-3 LinkedIn posts)
          LinkedIn poster adapter (w_member_social or clipboard)
          Board member approves via Communication Gateway (Tier 3)
```

### Contract Between Systems

The ONLY coupling between Optimus and umbadvisors is a JSON frontmatter schema for MDX files:

```typescript
interface BlogPostFrontmatter {
  title: string;
  slug: string;
  date: string;          // ISO 8601
  author: string;
  excerpt: string;
  tags: string[];
  seo: { title: string; description: string; keywords: string[] };
  optimus: { campaign_id: string; work_item_id: string; cost_usd: number };
}
```

Optimus doesn't know about Next.js. umbadvisors doesn't know about agent tiers.

### On Google ADK + MCP

**Keep the pattern, skip the framework.** The 5-phase pipeline directly mirrors Google's multi-agent architecture. Each phase runs as a sub-step inside executor-writer using Optimus's existing runExecutor() pattern, not as separate ADK-orchestrated agents. MCP can be explored later as a tool interface but is not load-bearing for this feature.

## Success Criteria

| Metric | Baseline | Target |
|--------|----------|--------|
| Blog post generation cost | N/A | < $0.50/post |
| LinkedIn post generation cost | ~$0.02-0.05 (manual Claude) | < $0.10/post |
| Draft approval rate | N/A | >= 60% |
| Posts per week | 0-1 (burnt out) | 3-4 |
| Board review time | ~60 min manual | < 5 min |
| Hard constraint catch rate | N/A | 100% |

## Risk Assessment

1. **Voice drift** -- Mitigated by edit delta feedback loop + deterministic hard constraint gates
2. **Blog/LinkedIn tone mismatch** -- Blog is formal/educational; LinkedIn is conversational. Content-atomizer must handle this translation, not just truncate.
3. **Research quality** -- Reddit/web polling may surface low-quality topics. Grounding phase (Phase 2) with RAG + authoritative sources is the filter.
4. **Multi-author complexity** -- 5 partners have different expertise areas and writing styles. Voice profiles must be per-author, not monolithic.

---

*SPEC.md updated: Phase 1.5 section added to section 14. CHANGELOG.md updated: v0.10.0.*
