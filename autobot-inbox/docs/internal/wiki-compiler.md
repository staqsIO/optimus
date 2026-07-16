# Wiki Compiler — Architecture & Source-Attribution Audit

**Status:** audit + first remediation step (STAQPRO-315) shipped 2026-05-11.
**Scope:** `lib/wiki/compiler.js`, `lib/wiki/clusterer.js`, `content.wiki_pages`, `content.documents.compile_status`.

## Why this doc exists

STAQPRO-311 Phase 4 (`v_wiki_metrics`) shipped on the assumption that compiled
`content.wiki_pages` are a curated knowledge layer surfaced to agents. A Phase 0
audit found that only **3 of 52** pages were sourced from the vault (`source =
'vault'`), with 23 having no `source_document_id` at all. That's the symptom
this doc explains.

## Pipeline

```
content.documents (compile_status = 'pending')
        │
        ▼
clusterDocuments()                   ── lib/wiki/clusterer.js
        │   greedy single-linkage, cosine ≥ 0.35, max 8 docs/cluster
        ▼
compileWiki()                        ── lib/wiki/compiler.js
        │   slice(0, maxArticles)    ── default 20 per batch
        ▼
compileCluster()                     ── per cluster
        │   LLM compile → sanitize → classify → ingest as wiki-compiled doc
        ▼
INSERT INTO content.wiki_pages       ── lib/wiki/compiler.js:622
    source_document_id = orderedSourceRows[0].id
UPDATE content.documents
    compile_status = 'compiled'
```

`compileWikiAllPendingScopes` wraps this in an outer loop that drains org-wide
docs first, then each project membership, up to 50 batches × 20 articles each.

## Two writers of `content.wiki_pages`

| Writer | File | Sets `source_document_id`? | Pages produced |
|--------|------|---|---|
| LLM compiler | `lib/wiki/compiler.js:622` | Yes — `orderedSourceRows[0].id` | Auto-compiled articles |
| Project route (create/index/manual) | `autobot-inbox/src/api-routes/projects.js:69,78,87,524` | **No** — column omitted | Hand-written project pages, project index pages, empty placeholder pages |

The 23 orphan pages in the Phase 0 audit are not a compiler bug — they are
**manually-created project pages with no source document by design**. They
shouldn't be re-targeted at a `source_document_id`; they should be
**classified separately** in metrics. STAQPRO-315's "orphan rate < 5%"
acceptance criterion needs to be reframed against compiler-written pages only.

## Why vault under-represents in `source_document_id`

Two compounding causes, in order of impact:

### 1. Greedy anchor selection favors dense email/TLDv clusters

`clusterer.js` (`clusterDocuments`):
- Builds a similarity matrix (cosine ≥ 0.35) over all pending docs' chunk centroids.
- Sorts by **neighbor count descending**, picks the most-connected unassigned doc as the cluster seed, pulls in neighbors up to `MAX_CLUSTER_SIZE = 8`.

Email summaries on a single thread share context wording and embed
very similarly — they form tight clusters of 3-8 documents. TLDv transcripts
on the same meeting series do the same. Vault notes typically cover
**different topics** — they rarely share enough vocabulary to meet the 0.35
threshold with other vault notes, so they end up as **singletons** or get
pulled into a cluster as the lone vault doc among 4 emails.

### 2. `source_document_id` records only the cluster anchor (single-valued)

`compileCluster` writes `source_document_id = orderedSourceRows[0]?.id`. The
schema is single-valued — no way to record "this page was synthesized from
docs A, B, C." Order comes from `cluster.docs` which the clusterer emits
**anchor-first**, where the anchor is the densest-connected doc (i.e. an
email summary, not the vault note).

Net effect: a vault note clustered with three email summaries gets compiled
(`compile_status` flips to `'compiled'`), its content is synthesized into the
page, but `wiki_pages.source_document_id` points to the email — making vault
contribution invisible to anyone querying provenance.

### 3. Embeddings preceded migration 021 backfill (possible)

Migration 021 set `compile_status='pending'` for `source='vault'` docs
retroactively. Any vault doc ingested before pgvector was available (or whose
chunks were never embedded) lands in the `withoutVec` branch of
`clusterDocuments`, where it becomes a single-doc cluster appended **last**.
With `maxArticles=20` per batch, large backlogs of embedded multi-doc
clusters bleed through 50 outer batches before unembedded vault notes
surface. Unknown how big this effect is without a prod query — filed as
follow-up audit item below.

## Remediation — phased

### Phase A (shipped 2026-05-11, this commit)

**Vault-anchor preference in `compileCluster`.** After `orderedSourceRows`
is built, stable-sort vault docs to the front. The cluster fingerprint is
order-independent (sorted-ids hash), so this never triggers a recompile loop.
On next compile pass, any cluster containing a vault doc will surface that
doc as the `source_document_id` — including via the upsert path
(`ON CONFLICT (project_id, slug) DO UPDATE`), which rewrites
`source_document_id` to the new anchor for existing pages whose primary
source has shifted.

**Limitations:**
- Does not change which clusters get compiled or in what order — the
  multi-doc-vs-singleton bias remains.
- Vault docs that were compiled but never re-touched (no fingerprint
  change) won't be re-anchored until something else updates them. A one-shot
  recompile-all pass would force the rewrite.

### Phase B — proposed (not in this commit)

1. **`content.wiki_page_sources` join table.** `(wiki_page_id, document_id,
   role)` where role ∈ `('primary', 'secondary')`. Eliminates the
   single-valued attribution loss entirely. Adds a backfill from existing
   `source_document_id` rows. Metrics like
   `v_wiki_metrics.knowledge_citation_rate_pct` then JOIN against the table
   instead of the column.

2. **Vault-direct compile path.** New entry point: each vault doc with
   `compile_status='pending'` gets compiled as a **forced singleton**,
   bypassing clustering. Lower LLM cost (smaller input), guaranteed
   1:1 provenance. Multi-doc clustering remains for non-vault sources.

3. **Reframe metric**: `v_wiki_metrics` should exclude manually-created
   project pages (those with `created_by` outside `('wiki-compiler', ...)`)
   from "orphan-rate" denominators.

### Phase C — proposed (research-only)

Reconsider the clustering threshold for vault notes. A higher threshold
(0.45-0.50) would push vault notes into singleton compilation more reliably;
a lower threshold (0.25-0.30) would create false-positive clusters across
unrelated vault topics. The current 0.35 is a compromise tuned for email/TLDv
density — vault content might benefit from a per-source threshold.

## Verification (Phase A)

`autobot-inbox/test/wiki-vault-anchor.test.js` currently verifies the
selection primitives behind this change: given a 3-doc cluster (one vault
note, two non-vault docs), `preferVaultAnchor` picks the vault doc
regardless of input order, and the cluster fingerprint helper produces the
same order-independent SHA hash for equivalent clusters. It does **not** yet
exercise `compileCluster` or DB-backed attribution on PGlite / production
schema; that end-to-end coverage remains a follow-up.

## References

- Linear: [STAQPRO-315](https://linear.app/staqs/issue/STAQPRO-315/wiki-compiler-under-couples-to-vault-only-3-of-52-wiki-pages-are-vault)
- Parent: STAQPRO-311 (wiki-in-prompts Phases 1-4)
- Compiler: `lib/wiki/compiler.js`, `lib/wiki/clusterer.js`
- Storage: `autobot-inbox/sql/039-wiki-pages.sql`, `021-wiki-compile.sql`
- Metric: `v_wiki_metrics` (migration 110)
