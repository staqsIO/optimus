# Research source ingestion (wiki)

External knowledge enters the wiki pipeline as `content.documents` (`source='feed'`), then the wiki compiler promotes pending docs into wiki pages.

## Components

- DB table: `content.research_sources`
  - Optional `project_id` scope
  - Poll metadata (`last_etag`, `last_modified`, `last_error`, timestamps)
  - `source_mode`: `url_watch` (page + optional web search) or `topic_search` (web search only, no page URL)
  - For `url_watch`: required `url` (https page to snapshot); optional `topic_query` (OpenAI web search run on the same poll, overlapping with the page ingest)
  - Controls (`is_active`, `poll_interval_ms`, `max_items_per_poll`)
- Poller: `autobot-inbox/src/research/research-source-poller.js`
  - Page path: fetches HTML via `normalizeUrl`, dedupes with deterministic `source_id` + `metadata.content_hash`
  - Optional search path: OpenAI Responses + `web_search_preview`, lines ingested as separate feed items
  - Marks docs `compile_status='pending'`
  - Adds project membership when the source is project-scoped
- Scheduler: `rd-feed-poller` service in `src/index.js` (legacy service name)
  - Interval controlled by `FEED_POLL_INTERVAL_MS` (default `900000` / 15m)
- API routes (canonical + compatibility aliases):
  - `GET /api/research-sources/subscriptions` (or `/api/feeds/subscriptions`)
  - `POST /api/research-sources/subscriptions` (or `/api/feeds/subscriptions`)
  - `DELETE /api/research-sources/subscriptions?id=...` (or `/api/feeds/subscriptions?id=...`)
  - `POST /api/research-sources/poll` (or `/api/feeds/poll`)

## Operational flow

1. Create one or more research sources (org-wide or project-scoped).
2. Poller ingests the watched page and any optional web-search lines.
3. Ingested docs become `compile_status='pending'` rows in `content.documents` (they do **not** appear in the wiki tree yet).
4. Run the wiki compiler (`POST /api/projects/compile`): project-scoped pending docs are only visible to `compileWiki` when scoped by `project_id` / `slug`. A **global** compile (no slug) only processes documents **without** any `project_memberships` row. **`POST /api/projects/compile` with `allPending: true` and no `slug`** runs an org-wide drain and then one drain per project that still has pending sources, so Knowledge Base “compile all pending” backfills every scope. The Wiki Vault **Compile pending → wiki** button still follows the sidebar scope (org vs one project). Output is `wiki_pages` plus `wiki-compiled` documents.

### Automatic compile after research poll

When `pollResearchSources` ingests new rows (`ingested > 0`), it can optionally run `compileWiki` for each affected scope (org-wide and/or touched `project_id`s):

- **Board manual poll**: `POST /api/research-sources/poll` with `auto_compile_wiki: true` (Wiki Vault does this) chains compile after a successful ingest.
- **Background scheduler** (`rd-feed-poller`): set **`WIKI_AUTO_COMPILE_AFTER_RESEARCH_POLL=1`** (or `true`/`on`/`yes`) on the inbox API service so scheduled polls also compile. Omit or set to `0`/`false` to disable.
- **`WIKI_AUTO_COMPILE_MAX_ARTICLES`**: max articles compiled **per scope** on that auto pass (default `10`, cap `50`).

## Notes

- Hardening: domain allow-lists and per-source cost/rate caps belong at the API boundary.
