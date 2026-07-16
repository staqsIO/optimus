/**
 * Wiki Linter — 5-category structural health checks on compiled wiki articles.
 *
 * Categories:
 *   1. Link integrity — verify all [[wikilinks]] resolve to existing articles
 *   2. Orphan detection — articles with no inbound links
 *   3. Staleness — compiled articles whose sources have been updated
 *   4. Thin content — articles below minimum size thresholds
 *   5. Contradiction detection — high-similarity articles with conflicting claims
 *
 * Output: JSON report suitable for project_memory storage or API response.
 */

import { query } from '../db.js';
import { extractWikilinks } from './compiler.js';

const MIN_WORD_COUNT = 100;
const MIN_CHUNK_COUNT = 2;

/**
 * Run all 5 lint checks on compiled wiki articles.
 *
 * @param {Object} [opts]
 * @param {string} [opts.projectId] - Scope to a project
 * @returns {Promise<WikiLintReport>}
 */
export async function lintWiki(opts = {}) {
  const startTime = Date.now();

  // Fetch all compiled wiki articles.
  // STAQPRO-545: collapse the per-article correlated chunk-count subquery into a
  // single pre-aggregated LEFT JOIN (was 163 SubPlan loops on the Staqs project).
  const articles = await query(
    `SELECT d.id, d.title, d.raw_text, d.classification, d.compiled_from,
            d.created_at, d.updated_at,
            COALESCE(cc.chunk_count, 0) AS chunk_count
     FROM content.documents d
     LEFT JOIN (
       SELECT c.document_id, count(*) AS chunk_count
       FROM content.chunks c
       GROUP BY c.document_id
     ) cc ON cc.document_id = d.id
     WHERE d.source = 'wiki-compiled'
     ORDER BY d.title`
  );

  if (articles.rows.length === 0) {
    return {
      timestamp: new Date().toISOString(),
      articleCount: 0,
      score: 100,
      issues: [],
      categories: { links: 0, orphans: 0, stale: 0, thin: 0, contradictions: 0 },
      durationMs: Date.now() - startTime,
    };
  }

  const issues = [];

  // Build link graph
  const articleTitles = new Set(articles.rows.map(a => a.title.toLowerCase()));
  const inboundLinks = new Map(); // title → Set of linking titles

  for (const article of articles.rows) {
    const links = extractWikilinks(article.raw_text || '');

    // Check 1: Link integrity
    for (const link of links) {
      // Track inbound links
      const normalizedLink = link.toLowerCase();
      if (!inboundLinks.has(normalizedLink)) inboundLinks.set(normalizedLink, new Set());
      inboundLinks.get(normalizedLink).add(article.title.toLowerCase());

      // Verify link target exists
      const targetExists = articleTitles.has(normalizedLink) ||
        articles.rows.some(a => a.title.toLowerCase().includes(normalizedLink));

      if (!targetExists) {
        issues.push({
          category: 'links',
          severity: 'warning',
          articleId: article.id,
          articleTitle: article.title,
          message: `Broken wikilink: [[${link}]] — no matching article found`,
          suggestion: `Create an article for "${link}" or remove the link`,
        });
      }
    }
  }

  // Check 2: Orphan detection
  for (const article of articles.rows) {
    const normalizedTitle = article.title.toLowerCase();
    const hasInbound = inboundLinks.has(normalizedTitle) && inboundLinks.get(normalizedTitle).size > 0;

    if (!hasInbound) {
      issues.push({
        category: 'orphans',
        severity: 'info',
        articleId: article.id,
        articleTitle: article.title,
        message: `Orphan article: no other articles link to this one`,
        suggestion: `Add [[${article.title}]] links from related articles`,
      });
    }
  }

  // Check 3: Staleness
  const allCompiledFrom = articles.rows
    .filter(a => a.compiled_from?.length > 0)
    .flatMap(a => a.compiled_from.map(srcId => ({ articleId: a.id, articleTitle: a.title, sourceId: srcId, compiledAt: a.updated_at })));

  if (allCompiledFrom.length > 0) {
    const sourceIds = [...new Set(allCompiledFrom.map(x => x.sourceId))];
    const sources = await query(
      `SELECT id, updated_at FROM content.documents WHERE id = ANY($1)`,
      [sourceIds]
    );
    const sourceUpdates = new Map(sources.rows.map(s => [s.id, s.updated_at]));

    for (const { articleId, articleTitle, sourceId, compiledAt } of allCompiledFrom) {
      const sourceUpdatedAt = sourceUpdates.get(sourceId);
      if (sourceUpdatedAt && new Date(sourceUpdatedAt) > new Date(compiledAt)) {
        issues.push({
          category: 'stale',
          severity: 'warning',
          articleId,
          articleTitle,
          message: `Stale: source document updated after compilation`,
          suggestion: `Recompile this article to incorporate source changes`,
        });
        break; // One staleness issue per article is enough
      }
    }
  }

  // Check 4: Thin content
  for (const article of articles.rows) {
    const wordCount = (article.raw_text || '').split(/\s+/).length;
    const chunkCount = parseInt(article.chunk_count);

    if (wordCount < MIN_WORD_COUNT) {
      issues.push({
        category: 'thin',
        severity: 'warning',
        articleId: article.id,
        articleTitle: article.title,
        message: `Thin content: ${wordCount} words (minimum ${MIN_WORD_COUNT})`,
        suggestion: `Add more detail or merge with a related article`,
      });
    } else if (chunkCount < MIN_CHUNK_COUNT) {
      issues.push({
        category: 'thin',
        severity: 'info',
        articleId: article.id,
        articleTitle: article.title,
        message: `Low chunk count: ${chunkCount} chunks (minimum ${MIN_CHUNK_COUNT})`,
        suggestion: `Article may be too short for effective retrieval`,
      });
    }
  }

  // Check 5: Contradiction detection (via title/topic overlap without linking)
  // Simple heuristic: articles with very similar titles that don't cross-link
  for (let i = 0; i < articles.rows.length; i++) {
    for (let j = i + 1; j < articles.rows.length; j++) {
      const a = articles.rows[i];
      const b = articles.rows[j];

      // Check if titles share significant words (potential topic overlap)
      const aWords = new Set(a.title.toLowerCase().split(/[\s—\-\/]+/).filter(w => w.length > 3));
      const bWords = new Set(b.title.toLowerCase().split(/[\s—\-\/]+/).filter(w => w.length > 3));
      const overlap = [...aWords].filter(w => bWords.has(w));

      if (overlap.length >= 2) {
        // Check if they cross-link
        const aLinks = extractWikilinks(a.raw_text || '').map(l => l.toLowerCase());
        const bLinks = extractWikilinks(b.raw_text || '').map(l => l.toLowerCase());
        const aLinksToB = aLinks.some(l => b.title.toLowerCase().includes(l));
        const bLinksToA = bLinks.some(l => a.title.toLowerCase().includes(l));

        if (!aLinksToB && !bLinksToA) {
          issues.push({
            category: 'contradictions',
            severity: 'info',
            articleId: a.id,
            articleTitle: a.title,
            message: `Potential overlap with "${b.title}" (shared terms: ${overlap.join(', ')}) — articles don't cross-link`,
            suggestion: `Review both articles for contradictions or merge opportunities`,
          });
        }
      }
    }
  }

  // Calculate health score (0-100)
  const errorCount = issues.filter(i => i.severity === 'error').length;
  const warningCount = issues.filter(i => i.severity === 'warning').length;
  const infoCount = issues.filter(i => i.severity === 'info').length;
  const score = Math.max(0, 100 - (errorCount * 20) - (warningCount * 5) - (infoCount * 1));

  const categories = {
    links: issues.filter(i => i.category === 'links').length,
    orphans: issues.filter(i => i.category === 'orphans').length,
    stale: issues.filter(i => i.category === 'stale').length,
    thin: issues.filter(i => i.category === 'thin').length,
    contradictions: issues.filter(i => i.category === 'contradictions').length,
  };

  return {
    timestamp: new Date().toISOString(),
    articleCount: articles.rows.length,
    score,
    issues,
    categories,
    durationMs: Date.now() - startTime,
  };
}
