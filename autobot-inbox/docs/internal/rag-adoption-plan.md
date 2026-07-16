# RAG Adoption Plan: Agentic RAG Article vs Optimus

**Date:** 2026-04-02
**Context:** Article proposes 6-layer Agentic RAG (Ray Serve, Qdrant, Neo4j, LangGraph, vLLM, Karpenter). This plan maps what applies to Optimus given our scale (2 board members, 18 agents, Railway + Supabase, 10K chunks) and principles (P4 boring infra, P5 measure first).

---

## Verdict Summary

| # | Feature | Adopt? | Priority | Effort | ROI at Our Scale |
|---|---------|--------|----------|--------|-----------------|
| 1 | Query rewriting | YES | P1 | Small | High |
| 2 | HyDE | NO | Skip | Medium | Low |
| 3 | Reranking | YES | P2 | Small | Medium |
| 4 | Hybrid retrieval (vector + graph) | YES | P3 | Medium | Medium |
| 5 | Semantic caching | NO | Skip | Medium | Negative |
| 6 | KG extraction during ingestion | LATER | P4 | Large | Low now |
| 7 | Evaluation pipeline | YES | P0 | Medium | Critical |
| 8 | Agent state machine (LangGraph) | NO | Skip | Large | Zero |

---

## P0: Evaluation Pipeline (Do First)

**Why first:** P5 says "measure before you trust." Without evaluation, we cannot tell whether any RAG improvement actually works. This gates everything else.

**Minimal viable version:**
- 30-50 hand-curated Q&A pairs (Eric + Dustin review real board-query questions)
- Store in `content.eval_golden` table (question, expected_answer, expected_doc_ids)
- Script that runs each question through `searchChunks()`, scores:
  - **Hit rate** (expected doc in top-k)
  - **MRR** (mean reciprocal rank of expected doc)
  - **Answer faithfulness** (LLM-as-judge: does synthesized answer match expected?)
- No Ragas dependency — raw SQL + one LLM call per eval pair

**Files to modify:**
- NEW: `sql/015-rag-eval.sql` — `content.eval_golden` table
- NEW: `scripts/rag-eval.js` — evaluation runner
- NEW: `scripts/seed-eval-golden.js` — initial golden dataset from board chat history

**Cost:** ~$0.50 per eval run (50 questions x Haiku synthesis + judge call)

---

## P1: Query Rewriting

**Why:** Board chat queries have conversation context ("What about that meeting?" means nothing without coreference resolution). Current retrieval treats each query in isolation.

**Minimal viable version:**
- Before embedding, pass the query + last 3 conversation turns to Haiku
- Prompt: "Rewrite this query to be self-contained, resolving any references to prior messages"
- Falls back to original query on timeout/error

**What's overengineered:** Multi-step query decomposition, sub-query fusion. At 10K chunks, a single rewritten query is sufficient.

**Files to modify:**
- `lib/rag/retriever.js` — add `rewriteQuery(query, conversationHistory)` before `embedOne()`
- `src/commands/agent-chat.js` — pass recent conversation turns to retriever
- `src/api-routes/search.js` — accept optional `conversationHistory` param

**Cost:** +$0.0003/query (Haiku rewrite). Negligible.

**Implementation:**

```js
// lib/rag/query-rewriter.js
import { callProvider } from '../llm/provider.js';

export async function rewriteQuery(query, history = []) {
  if (!history.length) return query;

  const historyBlock = history
    .slice(-3)
    .map(h => `${h.role}: ${h.content}`)
    .join('\n');

  const result = await callProvider('haiku', {
    system: 'Rewrite the user query to be self-contained. Resolve pronouns and references using conversation history. Return ONLY the rewritten query, nothing else.',
    messages: [{ role: 'user', content: `History:\n${historyBlock}\n\nQuery to rewrite: ${query}` }],
    maxTokens: 200,
  });

  return result?.text?.trim() || query;
}
```

---

## P2: Reranking

**Why:** Current retrieval returns top-30 by cosine similarity, then truncates by token budget. Cosine similarity with `text-embedding-3-small` is a decent first pass but misses semantic nuance. A cross-encoder reranker on the top-30 dramatically improves precision.

**Minimal viable version:**
- After `searchChunks()` returns top-30, call Cohere Rerank API (or Jina Reranker) on the results
- Reorder by relevance score, then apply token budget
- No self-hosted model — API call is fine at our volume

**What's overengineered:** Self-hosted cross-encoder on vLLM, custom fine-tuned reranker. At <100 queries/day, API reranking costs pennies.

**Files to modify:**
- NEW: `lib/rag/reranker.js` — Cohere/Jina rerank wrapper
- `lib/rag/retriever.js` — insert rerank step between search and context assembly in `retrieveContext()`
- `src/api-routes/search.js` — rerank before synthesis

**Implementation:**

```js
// lib/rag/reranker.js
const COHERE_API_KEY = process.env.COHERE_API_KEY;

export async function rerank(query, chunks, topN = 8) {
  if (!COHERE_API_KEY || chunks.length <= topN) return chunks;

  const res = await fetch('https://api.cohere.com/v2/rerank', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${COHERE_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'rerank-v3.5',
      query,
      documents: chunks.map(c => c.text),
      top_n: topN,
    }),
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) return chunks.slice(0, topN); // graceful fallback

  const data = await res.json();
  return data.results.map(r => ({
    ...chunks[r.index],
    rerankScore: r.relevance_score,
  }));
}
```

**Cost:** Cohere Rerank: $2/1000 searches. At 100 queries/day = $6/month.

---

## P3: Hybrid Retrieval (Vector + Graph)

**Why:** Neo4j already exists with schema and seed data (`lib/graph/`), but it's disconnected from RAG. Entity relationships (who works with whom, what projects relate to what) can't be found by vector similarity alone.

**Minimal viable version:**
- During retrieval, run vector search AND a simple graph query in parallel
- Graph query: extract entities from query (person names, project names), traverse 1-hop relationships
- Merge results: graph hits get a relevance boost, dedup by chunk ID

**What's overengineered:** Full GraphRAG with community detection, multi-hop reasoning, automated entity extraction during every query. At our scale, simple named entity matching + 1-hop traversal is enough.

**Prerequisites:** Neo4j must be connected in production (currently `NEO4J_URI` is unset on Railway).

**Files to modify:**
- `lib/rag/retriever.js` — add `hybridRetrieve()` that runs `searchChunks()` + `graphRetrieve()` in parallel
- NEW: `lib/rag/graph-retriever.js` — entity extraction + Neo4j traversal
- `lib/graph/queries.js` — add relationship-based chunk lookup queries

**Implementation sketch:**

```js
// lib/rag/graph-retriever.js
import { runCypher, isGraphAvailable } from '../graph/client.js';

export async function graphRetrieve(queryText) {
  if (!isGraphAvailable()) return [];

  // Extract likely entity names (simple heuristic: capitalized words)
  const entities = queryText.match(/[A-Z][a-z]+(?:\s[A-Z][a-z]+)*/g) || [];
  if (!entities.length) return [];

  const records = await runCypher(
    `UNWIND $names AS name
     MATCH (e {name: name})-[r]-(related)
     RETURN e.name AS entity, type(r) AS rel, related.name AS relatedName,
            related.chunkIds AS chunkIds
     LIMIT 20`,
    { names: entities },
    { readOnly: true }
  );

  // Return chunk IDs to boost in vector results
  return records?.flatMap(r => r.get('chunkIds') || []) ?? [];
}
```

---

## P4 (Later): Knowledge Graph Extraction During Ingestion

**Why later:** Requires Neo4j to be connected and useful first (P3). Entity extraction during ingestion is expensive and the graph needs to prove its value in retrieval before we invest in automated population.

**Minimal viable version (when ready):**
- After chunking, pass each chunk to Haiku with an extraction prompt
- Extract: (subject, predicate, object) triples
- Store in Neo4j as typed relationships
- Run as background task, not blocking ingestion

**Files to modify (future):**
- NEW: `lib/rag/entity-extractor.js`
- `lib/rag/ingest.js` — add optional extraction step after embedding
- `lib/graph/schema.js` — extend schema for extracted entities

**Cost:** ~$0.001/chunk x 10K chunks = $10 one-time, then incremental on new docs.

---

## SKIP: HyDE (Hypothetical Document Embeddings)

**Why skip:** HyDE generates a hypothetical answer, then embeds that instead of the query. This helps when queries and documents use very different vocabulary. At our scale:
- Our KB is mostly meeting transcripts and internal docs — same language as queries
- Query rewriting (P1) solves most of the query-document mismatch
- HyDE adds latency (full LLM generation before search) and cost
- If eval (P0) shows poor recall despite query rewriting, revisit

---

## SKIP: Semantic Caching

**Why skip:** Semantic caching embeds the query, checks if a similar query was recently answered, and serves the cached response. This makes sense at 10K+ queries/day to save LLM costs. For Optimus:
- ~50-100 queries/day (2 board members + occasional agent queries)
- Haiku synthesis costs $0.001/query = $3/month total
- Cache adds complexity (invalidation on KB updates, staleness bugs)
- The cache infrastructure costs more than the queries it saves
- P4 says boring infrastructure — an invalidation-prone cache layer is the opposite

---

## SKIP: Agent State Machine (LangGraph)

**Why skip:** The article uses LangGraph for planner -> retriever -> responder routing. Optimus already has this:
- Task graph with typed work items and state transitions
- Agent tier hierarchy with explicit routing (`config/agents.json`)
- Board-query agent already routes to RAG via `search_knowledge_base` tool

Adding LangGraph would be a second orchestration layer competing with the existing Postgres task graph. This violates P4 (boring infrastructure) and adds a dependency with no incremental value.

---

## Implementation Order

```
Week 1:  P0 — Evaluation pipeline (golden dataset + eval script)
         Run baseline eval to establish current retrieval quality numbers

Week 2:  P1 — Query rewriting
         Re-run eval to measure improvement

Week 3:  P2 — Reranking (Cohere API)
         Re-run eval to measure improvement

Week 4+: P3 — Hybrid retrieval (requires Neo4j connection in prod)
         P4 — KG extraction (only after P3 proves graph value)
```

**Total new cost:** ~$10/month (Cohere rerank + extra Haiku calls)
**Total new dependencies:** Cohere Rerank API (or Jina — both have free tiers)

---

## Architecture After Adoption

```
Query → [Rewrite (Haiku)] → [Embed (OpenAI)] → [Vector Search (pgvector)]
                                               → [Graph Search (Neo4j)]  ← P3
         ↓                                         ↓
         [Merge + Rerank (Cohere)] → [Token Budget] → [Synthesize (Haiku)]

Ingestion → Sanitize → Normalize → Chunk → Embed → Store
                                         → [Extract Entities → Neo4j]  ← P4

Evaluation → Golden Dataset → [Hit Rate, MRR, Faithfulness]  ← P0
```
