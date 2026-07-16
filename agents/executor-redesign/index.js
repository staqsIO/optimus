import { AgentLoop } from '../../lib/runtime/agent-loop.js';
import { query } from '../../lib/db.js';
import { createHash } from 'crypto';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { requirePermission, logCapabilityInvocation } from '../../lib/runtime/permissions.js';
import { publishEvent } from '../../lib/runtime/infrastructure.js';
import { runExecutor } from '../../lib/runtime/executor-adapter.js';
import { fetchWithTimeout } from '../../lib/runtime/fetch-utils.js';
import { extractBusinessContext, generateStrategyBrief } from '../redesign-strategy/index.js';
import { createChildLogger } from '../../lib/logger.js';
import { scrapeForBrand } from '../../lib/scrapers/index.js';
import { selectComponents, getLibraryHash } from './component-selector.js';
import { matchProductsToIntent, renderIntentBrief } from './intent-matcher.js';
import { scoreDomainAEO } from './aeo-client.js';
import { screenRedesignInput, runPublishGate } from '../../lib/runtime/redesign-safety.js';

const log = createChildLogger({ agent: 'executor-redesign' });

const designSystem = JSON.parse(
  readFileSync(new URL('../../autobot-inbox/config/design-system.json', import.meta.url), 'utf-8')
);

// Pre-compute framework color set for brand detection filtering
const FRAMEWORK_COLORS = new Set([
  ...designSystem.frameworkColors.bootstrap,
  ...designSystem.frameworkColors.tailwind,
  ...designSystem.frameworkColors.material,
]);

/**
 * Executor-Redesign agent: scrape → analyze → generate → review website redesigns.
 *
 * Runs on Jamie M1. Polls the task graph for website_redesign work items,
 * claims them atomically, and produces a self-contained HTML redesign.
 *
 * Pipeline:
 *   -1. Check design system cache (24h TTL, same URL)
 *   0. Lighthouse audit on original URL
 *   1. Scrape target URL with Playwright (HTML + design data + AEO audit)
 *   2. Analyze design with Claude Sonnet API (structured JSON output)
 *   2.1 Extract business context (pure JS, $0)
 *   2.2 Generate strategy brief (template, $0)
 *   2.3 Build structured design system → design-system.json (or use cache)
 *   2.4 Validate design system against JSON schema (P2 enforcement)
 *   2.5 Render design-brief.md FROM validated design system
 *   3. Generate redesign with Claude Code CLI (Pass 1) — strategic design partner
 *   4. Parallel review: Delphi (UI/UX + strategy) + Linus (code quality)
 *   5. Apply combined feedback (Pass 3)
 *   6. Audit redesign, store in Postgres (including design system + strategy rationale)
 *
 * Gates: G1 (budget), G6 (rate limiting in API layer)
 * Security: URL validation in API layer (SSRF), script stripping on output
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORK_DIR = join(__dirname, '..', '..', 'data', 'redesigns');
const DEFAULT_MAX_BUDGET_USD = 2.00;
const SCRAPE_TIMEOUT_MS = 30_000;
const CLI_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes for generation pass
const FALLBACK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes for fallback models
const REVIEW_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes per review pass
const DB_KEEPALIVE_INTERVAL_MS = 20_000; // ping DB every 20s during long ops

// scrapeUrl() extracted to lib/scrapers/playwright.js — use scrapeForBrand() instead

/**
 * Run Lighthouse audit against a live URL.
 * Returns { performance, accessibility, seo, 'best-practices' } scores (0-100).
 */
async function auditUrl(targetUrl) {
  const chromeLauncher = await import('chrome-launcher');
  const lighthouse = await import('lighthouse');

  const chrome = await chromeLauncher.launch({ chromeFlags: ['--headless', '--no-sandbox'] });
  try {
    const result = await lighthouse.default(targetUrl, {
      port: chrome.port,
      output: 'json',
      onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
    });
    const categories = result.lhr.categories;
    const scores = {
      performance: Math.round((categories.performance?.score || 0) * 100),
      accessibility: Math.round((categories.accessibility?.score || 0) * 100),
      seo: Math.round((categories.seo?.score || 0) * 100),
      'best-practices': Math.round((categories['best-practices']?.score || 0) * 100),
    };

    // Extract failing audits per category for targeted regression fixes
    const failingAudits = {};
    for (const [catKey, cat] of Object.entries(categories)) {
      const failed = (cat.auditRefs || [])
        .filter(ref => ref.weight > 0)
        .map(ref => result.lhr.audits[ref.id])
        .filter(a => a && a.score !== null && a.score < 1)
        .map(a => ({ id: a.id, title: a.title, score: a.score, description: (a.description || '').slice(0, 120) }));
      if (failed.length > 0) failingAudits[catKey] = failed;
    }
    scores._failingAudits = failingAudits;

    return scores;
  } finally {
    await chrome.kill();
  }
}

/**
 * Custom AEO (Answer Engine Optimization) scorer.
 * Evaluates HTML for AI/answer-engine extractability using the Playwright page object.
 * Returns { aeoScore: number, breakdown: {...} }.
 */
async function auditAEO(page) {
  return page.evaluate(() => {
    const breakdown = {};

    // 1. JSON-LD structured data (15 points)
    const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
    const schemaTypes = new Set();
    jsonLdScripts.forEach(s => {
      try {
        const data = JSON.parse(s.textContent);
        if (data['@type']) schemaTypes.add(data['@type']);
        if (Array.isArray(data['@graph'])) data['@graph'].forEach(g => { if (g['@type']) schemaTypes.add(g['@type']); });
      } catch {}
    });
    breakdown.structured_data = Math.min(15, schemaTypes.size * 5);

    // 2. FAQ markup (15 points)
    const hasFaqSchema = Array.from(jsonLdScripts).some(s => s.textContent.includes('FAQPage'));
    const detailsEls = document.querySelectorAll('details');
    breakdown.faq_markup = hasFaqSchema ? 15 : Math.min(10, detailsEls.length * 3);

    // 3. Entity identification (10 points)
    const hasOrgSchema = Array.from(jsonLdScripts).some(s => {
      try { const d = JSON.parse(s.textContent); return d['@type'] === 'Organization' && d.name && d.url; } catch { return false; }
    });
    const hasPersonSchema = Array.from(jsonLdScripts).some(s => {
      try { const d = JSON.parse(s.textContent); return d['@type'] === 'Person' || (d.founder && d.founder['@type'] === 'Person'); } catch { return false; }
    });
    breakdown.entity_clarity = (hasOrgSchema ? 6 : 0) + (hasPersonSchema ? 4 : 0);

    // 4. Semantic heading hierarchy (10 points)
    const h1s = document.querySelectorAll('h1');
    const h2s = document.querySelectorAll('h2');
    const h3s = document.querySelectorAll('h3');
    let headingScore = 0;
    if (h1s.length === 1) headingScore += 4;
    else if (h1s.length > 0) headingScore += 2;
    if (h2s.length > 0) headingScore += 3;
    if (h3s.length > 0) headingScore += 3;
    breakdown.heading_hierarchy = headingScore;

    // 5. Meta description (5 points)
    const metaDesc = document.querySelector('meta[name="description"]');
    const descContent = metaDesc?.getAttribute('content') || '';
    breakdown.meta_description = metaDesc ? (descContent.length >= 120 && descContent.length <= 160 ? 5 : 3) : 0;

    // 6. Open Graph completeness (5 points)
    const ogTags = ['og:title', 'og:description', 'og:image', 'og:type'];
    const ogPresent = ogTags.filter(tag => document.querySelector(`meta[property="${tag}"]`)).length;
    breakdown.open_graph = Math.round((ogPresent / ogTags.length) * 5);

    // 7. Content-to-HTML ratio (10 points)
    const textContent = document.body?.innerText || '';
    const htmlContent = document.documentElement?.outerHTML || '';
    const ratio = textContent.length / (htmlContent.length || 1);
    breakdown.content_ratio = ratio >= 0.25 ? 10 : Math.round(ratio / 0.25 * 10);

    // 8. Direct answer blocks (10 points)
    const headings = document.querySelectorAll('h1, h2, h3, h4');
    let answerBlocks = 0;
    headings.forEach(h => {
      let next = h.nextElementSibling;
      if (next && (next.tagName === 'P' || next.tagName === 'DIV')) {
        const text = next.textContent?.trim() || '';
        if (text.length > 20 && text.length < 300) answerBlocks++;
      }
    });
    breakdown.answer_blocks = Math.min(10, answerBlocks * 3);

    // 9. Contact info extractability (10 points)
    const bodyText = document.body?.innerHTML || '';
    const hasEmail = /[\w.-]+@[\w.-]+\.\w{2,}/.test(bodyText);
    const hasPhone = /(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/.test(bodyText);
    const hasAddress = Array.from(jsonLdScripts).some(s => s.textContent.includes('PostalAddress'));
    breakdown.contact_info = (hasEmail ? 4 : 0) + (hasPhone ? 3 : 0) + (hasAddress ? 3 : 0);

    // 10. Publication/freshness signals (10 points)
    const hasDateModified = Array.from(jsonLdScripts).some(s => s.textContent.includes('dateModified'));
    const hasDatePublished = Array.from(jsonLdScripts).some(s => s.textContent.includes('datePublished'));
    const hasAuthor = Array.from(jsonLdScripts).some(s => s.textContent.includes('"author"'));
    const hasTimestamp = !!document.querySelector('time[datetime]');
    breakdown.freshness_signals = (hasDateModified ? 4 : 0) + (hasDatePublished ? 3 : 0) + (hasAuthor ? 2 : 0) + (hasTimestamp ? 1 : 0);

    const aeoScore = Object.values(breakdown).reduce((sum, v) => sum + v, 0);
    return { aeoScore, breakdown };
  });
}

/**
 * Run Lighthouse + AEO audit on a local HTML file by serving it via temp HTTP server.
 * Returns { lighthouse: {...scores}, aeo: { aeoScore, breakdown } }.
 */
async function auditLocalFile(filePath) {
  const http = await import('http');
  const fs = await import('fs');

  const html = fs.readFileSync(filePath, 'utf-8');

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const localUrl = `http://127.0.0.1:${port}`;

  try {
    // Lighthouse audit
    const lighthouseScores = await auditUrl(localUrl);

    // AEO audit using Playwright
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    let aeoResult;
    try {
      const page = await browser.newPage();
      await page.goto(localUrl, { waitUntil: 'networkidle', timeout: 10000 });
      aeoResult = await auditAEO(page);
    } finally {
      await browser.close();
    }

    return { lighthouse: lighthouseScores, aeo: aeoResult };
  } finally {
    server.close();
  }
}

/**
 * Analyze the scraped design using Claude Sonnet API (structured output).
 * Returns a JSON analysis of the design.
 */
async function analyzeDesign(agent, scraped, taskId) {
  const systemPrompt = `You are a senior web designer analyzing a website for a redesign project.
Analyze the provided HTML and design data, then return a JSON object with your analysis.
Focus on actionable insights for improving the design while preserving brand identity.

Return ONLY valid JSON with this structure:
{
  "brand_identity": { "name": string, "colors": string[], "fonts": string[], "tone": string },
  "strengths": string[],
  "weaknesses": string[],
  "layout_pattern": string,
  "improvements": string[],
  "recommended_style": string,
  "accessibility_issues": string[]
}`;

  // Truncate HTML to fit context (keep head + first 3000 chars of body)
  const headMatch = scraped.html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  const bodyMatch = scraped.html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const truncatedHtml = (headMatch ? headMatch[0] : '') + '\n' +
    (bodyMatch ? bodyMatch[1].slice(0, 3000) + '...' : scraped.html.slice(0, 4000));

  const userMessage = `Analyze this website design:

Title: ${scraped.title}
Meta description: ${scraped.meta.description || 'none'}

Design data:
${JSON.stringify(scraped.designData, null, 2)}

HTML (truncated):
${truncatedHtml}`;

  const result = await agent.callLLM(systemPrompt, userMessage, {
    taskId,
    idempotencyKey: `redesign-analyze-${taskId}`,
    maxTokens: 2048,
  });

  // Parse JSON from response (handle markdown code blocks)
  let analysis;
  try {
    const jsonStr = result.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    analysis = JSON.parse(jsonStr);
  } catch {
    log.warn('Failed to parse analysis JSON, using raw text');
    analysis = { raw: result.text, strengths: [], weaknesses: [], improvements: [] };
  }

  return { analysis, costUsd: result.costUsd };
}

/**
 * Assemble the blueprint context package for a single-pass generation.
 * Writes CLAUDE.md + component references to the work directory.
 */
function assembleBlueprint(jobDir, { designSystem, strategyBriefMd, businessContext, components }) {
  // Write the blueprint template as CLAUDE.md
  const blueprintPath = join(__dirname, 'blueprint-template.md');
  const blueprint = readFileSync(blueprintPath, 'utf-8');
  writeFileSync(join(jobDir, 'CLAUDE.md'), blueprint);

  // Write component references if available
  if (components && components.length > 0) {
    const lines = ['# Component References\n'];
    lines.push('Use these human-designed component patterns as quality references.');
    lines.push('Adapt them to match the brand identity and design system.\n');
    for (const comp of components) {
      lines.push(`## ${comp.section.toUpperCase()}: ${comp.id}\n`);
      lines.push(comp.prompt);
      lines.push('');
    }
    writeFileSync(join(jobDir, 'component-references.md'), lines.join('\n'));
  } else {
    writeFileSync(join(jobDir, 'component-references.md'), '# No component references selected\n\nGenerate all components from scratch using the design system and strategy brief.');
  }

  log.info(` Blueprint assembled: CLAUDE.md + ${components?.length || 0} component references`);
}

/**
 * Generate a redesign using the blueprint pattern — single CLI call.
 * Claude Code reads CLAUDE.md and all context files, generates, and self-verifies.
 */
function generateFromBlueprint(jobDir, config) {
  return runExecutor({
    prompt: 'Read CLAUDE.md and follow the blueprint to create the website redesign. Complete all 3 phases: Research, Generate, and Self-Verify. Fix any issues found during self-verification before reporting completion.',
    systemPrompt: 'You are a strategic design partner creating a website redesign. Follow the CLAUDE.md blueprint exactly. Quality matters more than speed — self-verify everything.',
    workDir: jobDir,
    maxBudgetUsd: config.maxBudgetUsd || 2.50,
    model: config.model || 'sonnet',
    backend: config.backend || 'claude',
    allowedTools: config.allowedTools || ['Read', 'Write', 'Glob', 'Grep'],
    maxTurns: config.maxTurns || 35,
    timeoutMs: config.timeoutMs || 10 * 60 * 1000, // 10 minutes
    extensions: config.extensions,
    allowedMcpServers: config.allowedMcpServers,
    label: 'blueprint-generate',
    agentTag: 'executor-redesign',
  });
}

// Audits that structurally fail in preview (http://localhost) — cannot be fixed by HTML editing
const PREVIEW_STRUCTURAL_AUDITS = new Set([
  'is-on-https',      // Best Practices: always fails on http://
  'redirects-http',   // Best Practices: HTTP→HTTPS redirect
  'robots-txt',       // SEO: temp server has no robots.txt
  'uses-http2',       // Performance: localhost Node server
]);

/**
 * Compare before/after audit scores and return any regressions.
 */
function findRegressions(auditBefore, auditAfter, aeoBeforeScore, aeoAfterScore) {
  if (!auditBefore || !auditAfter) return [];

  const checks = [
    { key: 'seo', label: 'SEO', hint: 'Check meta tags, heading hierarchy, structured data, alt text' },
    { key: 'accessibility', label: 'Accessibility', hint: 'Check contrast, ARIA labels, focus order, skip links' },
    { key: 'performance', label: 'Performance', hint: 'Reduce CSS bloat, optimize font loading, minimize DOM' },
    { key: 'best-practices', label: 'Best Practices', hint: 'Fix HTTPS, charset, doctype, image aspect ratios' },
  ];

  const regressions = [];
  const failingAudits = auditAfter._failingAudits || {};
  for (const { key, label, hint } of checks) {
    const before = auditBefore[key];
    const after = auditAfter[key];
    if (typeof before === 'number' && typeof after === 'number' && after < before) {
      const failedAuditIds = (failingAudits[key] || []).map(a => a.id);
      const hasNonStructuralFailure = failedAuditIds.some(id => !PREVIEW_STRUCTURAL_AUDITS.has(id));
      // Skip if every failure is structural (not fixable by HTML editing)
      if (failedAuditIds.length > 0 && !hasNonStructuralFailure) continue;
      const failed = (failingAudits[key] || []).map(a => `- ${a.title} (${a.id}): ${a.description}`).join('\n');
      regressions.push({ key, label, before, after, delta: after - before, hint, failingAudits: failed || hint });
    }
  }

  // AEO check
  if (typeof aeoBeforeScore === 'number' && typeof aeoAfterScore === 'number' && aeoAfterScore < aeoBeforeScore) {
    regressions.push({
      key: 'aeo', label: 'AEO / AI Readiness', before: aeoBeforeScore, after: aeoAfterScore,
      delta: aeoAfterScore - aeoBeforeScore, hint: 'Add structured data, FAQ markup, short answer paragraphs, contact info',
    });
  }

  return regressions;
}

/**
 * Send redesign completion email via Resend API.
 * Template matches staqs.io terminal aesthetic.
 */
async function sendRedesignEmail(to, targetUrl, previewUrl, { auditBefore, auditAfter } = {}) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY not configured');

  const domain = new URL(targetUrl).hostname;

  // Build score comparison rows for the email
  const scoreCategories = [
    { key: 'seo', label: 'SEO' },
    { key: 'aeo', label: 'AEO / AI Readiness' },
    { key: 'performance', label: 'Performance' },
    { key: 'accessibility', label: 'Accessibility' },
    { key: 'best-practices', label: 'Best Practices' },
  ];

  function scoreColor(score) {
    if (score >= 90) return '#22c55e'; // green
    if (score >= 50) return '#eab308'; // yellow
    return '#ef4444'; // red
  }

  function buildScoreRows() {
    if (!auditBefore && !auditAfter) return '';
    return scoreCategories.map(({ key, label }) => {
      const before = auditBefore?.[key] ?? '—';
      const after = auditAfter?.[key] ?? '—';
      const delta = (typeof before === 'number' && typeof after === 'number')
        ? after - before : null;
      const deltaStr = delta !== null
        ? `<span style="color:${delta >= 0 ? '#22c55e' : '#ef4444'};">${delta >= 0 ? '+' : ''}${delta}</span>`
        : '';
      const beforeColor = typeof before === 'number' ? scoreColor(before) : '#64748b';
      const afterColor = typeof after === 'number' ? scoreColor(after) : '#64748b';
      return `<tr>
        <td style="padding:4px 8px;color:#94a3b8;font-size:12px;text-align:left;">${label}</td>
        <td style="padding:4px 8px;color:${beforeColor};font-size:12px;text-align:center;font-weight:600;">${before}</td>
        <td style="padding:4px 8px;color:#64748b;font-size:12px;text-align:center;">&rarr;</td>
        <td style="padding:4px 8px;color:${afterColor};font-size:12px;text-align:center;font-weight:600;">${after}</td>
        <td style="padding:4px 8px;font-size:12px;text-align:right;">${deltaStr}</td>
      </tr>`;
    }).join('\n');
  }

  function buildScoreTable() {
    if (!auditBefore && !auditAfter) return '';
    const rows = buildScoreRows();
    // Find worst "before" score to highlight as opportunity
    let worstCategory = null;
    let worstScore = 101;
    for (const { key, label } of scoreCategories) {
      const score = auditBefore?.[key];
      if (typeof score === 'number' && score < worstScore) {
        worstScore = score;
        worstCategory = label;
      }
    }
    const opportunityLine = worstCategory && worstScore < 70
      ? `<p style="color:#eab308;margin:12px 0 0;font-size:11px;">&#9888; Your ${worstCategory} score (${worstScore}/100) is hurting discoverability. We can fix that.</p>`
      : '';
    return `
        <div style="border-top:1px solid #2a3a4a;padding-top:16px;margin-top:16px;">
          <p style="color:#64748b;margin:0 0 8px;font-size:12px;">// site audit: before vs after</p>
          <table style="width:100%;border-collapse:collapse;">
            <tr>
              <th style="padding:4px 8px;color:#64748b;font-size:10px;text-align:left;text-transform:uppercase;letter-spacing:1px;">Metric</th>
              <th style="padding:4px 8px;color:#64748b;font-size:10px;text-align:center;text-transform:uppercase;letter-spacing:1px;">Before</th>
              <th style="padding:4px 8px;"></th>
              <th style="padding:4px 8px;color:#64748b;font-size:10px;text-align:center;text-transform:uppercase;letter-spacing:1px;">After</th>
              <th style="padding:4px 8px;color:#64748b;font-size:10px;text-align:right;text-transform:uppercase;letter-spacing:1px;">Change</th>
            </tr>
            ${rows}
          </table>${opportunityLine}
        </div>`;
  }

  const scoreTableHtml = buildScoreTable();

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#0f1923;font-family:'SF Mono',SFMono-Regular,Consolas,'Liberation Mono',Menlo,monospace;">
  <div style="max-width:600px;margin:0 auto;padding:40px 24px;">

    <!-- Header -->
    <div style="text-align:center;margin-bottom:32px;">
      <h1 style="color:#22c55e !important;font-size:28px;letter-spacing:4px;margin:0;font-weight:700;"><a href="https://staqs.io" style="color:#22c55e !important;text-decoration:none !important;">STAQS<span style="display:none;"> </span>.IO</a></h1>
      <p style="color:#64748b !important;font-size:11px;letter-spacing:3px;margin:4px 0 0;text-transform:uppercase;">Agentic Engineering Studio</p>
    </div>

    <!-- Terminal window -->
    <div style="background-color:#1a2332;border:1px solid #2a3a4a;border-radius:8px;overflow:hidden;">

      <!-- Title bar -->
      <div style="background-color:#152029;padding:10px 16px;display:flex;align-items:center;">
        <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#ef4444;margin-right:6px;"></span>
        <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#eab308;margin-right:6px;"></span>
        <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#22c55e;margin-right:6px;"></span>
        <span style="color:#64748b;font-size:12px;margin-left:8px;">staqs@terminal ~ %</span>
      </div>

      <!-- Content -->
      <div style="padding:24px;">
        <p style="color:#22c55e;margin:0 0 4px;font-size:14px;">$ staqs redesign --complete</p>
        <p style="color:#64748b;margin:0 0 20px;font-size:12px;">// redesign pipeline finished</p>

        <p style="color:#e2e8f0;margin:0 0 6px;font-size:14px;"><span style="color:#22c55e;">[=========]</span> Done!</p>
        <p style="color:#e2e8f0;margin:0 0 20px;font-size:13px;">
          <span style="color:#22c55e;">&#10022;</span> Your redesign of <span style="color:#22c55e !important;">${domain.replace('.', '<span style="display:none;"> </span>.')}</span> is ready.
        </p>

        <!-- CTA Button -->
        <div style="text-align:center;margin:28px 0;">
          <a href="${previewUrl}" style="display:inline-block;background-color:#22c55e;color:#0f1923;padding:14px 32px;text-decoration:none;font-weight:700;font-size:14px;border-radius:4px;letter-spacing:1px;">VIEW YOUR REDESIGN &rarr;</a>
        </div>

        <p style="color:#64748b;margin:20px 0 4px;font-size:12px;">// shareable link (yours to keep):</p>
        <p style="margin:0 0 20px;font-size:12px;"><a href="${previewUrl}" style="color:#22c55e;text-decoration:underline;">${previewUrl}</a></p>

        ${scoreTableHtml}

        <div style="border-top:1px solid #2a3a4a;padding-top:16px;margin-top:16px;">
          <p style="color:#64748b;margin:0 0 4px;font-size:12px;">// what just happened:</p>
          <p style="color:#94a3b8;margin:0;font-size:12px;line-height:1.8;">
            &gt; Playwright scraped your live homepage<br>
            &gt; Analyzed your business, audience &amp; conversion goals<br>
            &gt; Generated a strategic design brief (hero psychology, cognitive fluency, conversion architecture)<br>
            &gt; Claude Code built a redesign driven by your business objectives<br>
            &gt; Output: self-contained, mobile-responsive, WCAG AA
          </p>
        </div>
      </div>
    </div>

    <!-- Footer -->
    <div style="text-align:center;margin-top:32px;">
      <p style="color:#64748b;font-size:12px;margin:0 0 8px;">We analyzed your business, audience &amp; conversion goals. Impressed?</p>
      <p style="margin:0 0 16px;"><a href="mailto:hello@staqs.io" style="color:#22c55e;font-size:14px;text-decoration:none;font-weight:600;">hello@staqs.io &rarr;</a></p>
      <p style="color:#475569;font-size:11px;margin:0;">
        <a href="https://staqs.io" style="color:#475569;text-decoration:none;">staqs.io</a>
        &nbsp;&middot;&nbsp;
        <a href="https://github.com/staqsIO" style="color:#475569;text-decoration:none;">GitHub</a>
        &nbsp;&middot;&nbsp;
        <a href="https://linkedin.com/company/staqs" style="color:#475569;text-decoration:none;">LinkedIn</a>
      </p>
    </div>

  </div>
</body>
</html>`;

  // Build plain-text score table
  let scoreTextBlock = '';
  if (auditBefore || auditAfter) {
    const lines = scoreCategories.map(({ key, label }) => {
      const before = auditBefore?.[key] ?? '—';
      const after = auditAfter?.[key] ?? '—';
      const delta = (typeof before === 'number' && typeof after === 'number') ? after - before : null;
      const deltaStr = delta !== null ? ` (${delta >= 0 ? '+' : ''}${delta})` : '';
      return `  ${label.padEnd(18)} ${String(before).padStart(3)}  →  ${String(after).padStart(3)}${deltaStr}`;
    });
    scoreTextBlock = `\nSite Audit (before → after):\n${lines.join('\n')}\n`;
  }

  const textVersion = `Your redesign of ${domain} is ready!

View it here: ${previewUrl}
${scoreTextBlock}
What happened:
- Playwright scraped your live homepage
- Analyzed your business, audience & conversion goals
- Generated a strategic design brief (hero psychology, cognitive fluency, conversion architecture)
- Claude Code built a redesign driven by your business objectives
- Output: self-contained, mobile-responsive, WCAG AA

We analyzed your business, audience & conversion goals. Impressed?
hello@staqs.io — https://staqs.io`;

  const res = await fetchWithTimeout('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM || 'STAQS.IO <hello@staqs.io>',
      to: [to],
      subject: `Your redesign of ${domain} is ready`,
      html,
      text: textVersion,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend API error (${res.status}): ${body}`);
  }
}

/**
 * Heartbeat: update work_items.updated_at and metadata.heartbeat_at every interval
 * to signal liveness. The reaper uses stale updated_at to detect dead agents.
 * Also writes progress_phase so the frontend can show real status.
 *
 * Returns { stop(), setPhase(phase) }.
 */
function startHeartbeat(workItemId) {
  let currentPhase = 'starting';

  const timer = setInterval(async () => {
    try {
      await query(
        `UPDATE agent_graph.work_items
         SET updated_at = now(),
             metadata = metadata || jsonb_build_object(
               'heartbeat_at', to_jsonb(now()::text),
               'progress_phase', to_jsonb($2::text)
             )
         WHERE id = $1`,
        [workItemId, currentPhase]
      );
    } catch (err) {
      log.warn(` Heartbeat failed: ${err.message}`);
    }
  }, DB_KEEPALIVE_INTERVAL_MS);

  return {
    stop: () => clearInterval(timer),
    setPhase: (phase) => { currentPhase = phase; },
  };
}

/**
 * Query with retry — for critical writes that must not be lost.
 * Retries up to 3 times with 2s backoff.
 */
async function queryWithRetry(text, params, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await query(text, params);
    } catch (err) {
      log.warn(` DB query attempt ${attempt}/${maxRetries} failed: ${err.message}`);
      if (attempt === maxRetries) throw err;
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
}

// ── Design System Extraction (DESIGN.md pipeline) ────────────────

const modernPatterns = JSON.parse(
  readFileSync(new URL('../../autobot-inbox/config/modern-patterns.json', import.meta.url), 'utf-8')
);

/**
 * Analyze scraped HTML/CSS for 2025-2026 design pattern gaps.
 * Compares extracted patterns against config/modern-patterns.json checklist.
 * Returns array of { pattern, description, priority, directive } for missing patterns.
 */
function analyzePatternGaps(scraped) {
  const html = scraped.html || '';
  const gaps = [];

  for (const pattern of modernPatterns.patterns) {
    let detected = false;

    // Check CSS patterns in the HTML (inline styles + <style> blocks)
    for (const cssPat of (pattern.detect.cssPatterns || [])) {
      if (html.includes(cssPat)) { detected = true; break; }
    }

    // Check HTML patterns (class names, elements)
    if (!detected) {
      for (const htmlPat of (pattern.detect.htmlPatterns || [])) {
        // Handle attribute-contains selectors like class*="bento"
        const match = htmlPat.match(/^class\*="(.+)"$/);
        if (match) {
          if (html.toLowerCase().includes(match[1].toLowerCase())) { detected = true; break; }
        } else if (htmlPat.startsWith('data-')) {
          if (html.includes(htmlPat)) { detected = true; break; }
        } else {
          // Element name check (e.g., "svg")
          if (html.includes(`<${htmlPat}`)) { detected = true; break; }
        }
      }
    }

    if (!detected) {
      gaps.push({
        pattern: pattern.name,
        description: pattern.description,
        priority: pattern.priority,
        directive: pattern.directive,
      });
    }
  }

  return gaps;
}

/**
 * Build a structured design system JSON from all extracted data.
 * Consolidates scraped designData, analysis, businessContext, and audit scores
 * into a single validated artifact.
 */
function buildDesignSystem(scraped, analysis, businessContext, auditBefore) {
  const brand = scraped.designData?.brand || {};
  const images = scraped.images || [];
  const contentHash = createHash('sha256').update(scraped.html.slice(0, 10000)).digest('hex');

  // Separate primary brand colors from secondary palette
  const primaryColors = brand.primaryColors || [];
  const allPalette = scraped.designData?.colorPalette || [];
  const secondaryColors = allPalette
    .filter(c => !primaryColors.includes(c))
    .slice(0, 10);
  const neutralColors = allPalette
    .filter(c => /^#[0-9a-f]{6}$/i.test(c))
    .filter(c => {
      const r = parseInt(c.slice(1, 3), 16);
      const g = parseInt(c.slice(3, 5), 16);
      const b = parseInt(c.slice(5, 7), 16);
      return Math.max(r, g, b) - Math.min(r, g, b) < 30; // low saturation = neutral
    })
    .slice(0, 5);

  // Detect button style from brand signals
  const buttonColors = brand.signals?.buttons || [];
  const buttonStyle = buttonColors.length > 0 ? 'fill' : 'outline';

  // Detect motion from HTML
  const hasAnimations = (scraped.html || '').includes('@keyframes') ||
    (scraped.html || '').includes('animation:') ||
    (scraped.html || '').includes('data-aos');
  const hasTransitions = (scraped.html || '').includes('transition:');

  // Pattern gap analysis
  const patternGaps = analyzePatternGaps(scraped);

  return {
    version: '1.0.0',
    source: {
      url: scraped.meta?.ogImage ? new URL(scraped.meta.ogImage).origin : 'unknown',
      scrapedAt: new Date().toISOString(),
      contentHash,
    },
    colors: {
      hasClearBranding: brand.hasClearBranding || false,
      primary: primaryColors,
      secondary: secondaryColors,
      neutral: neutralColors,
      semantic: {
        cta: buttonColors,
        nav: brand.signals?.nav || [],
        heading: brand.signals?.headings || [],
        link: brand.signals?.links || [],
        background: scraped.designData?.bodyBg || '',
      },
    },
    typography: {
      bodyFont: scraped.designData?.bodyFont || '',
      bodyColor: scraped.designData?.bodyColor || '',
      headings: (scraped.designData?.headings || []).map(h => ({
        tag: h.tag,
        font: h.font,
        color: h.color,
        text: h.text,
      })),
      recommended: businessContext.fontPairing ? {
        heading: businessContext.fontPairing.heading,
        body: businessContext.fontPairing.body,
        weights: businessContext.fontPairing.weights,
        vibe: businessContext.fontPairing.vibe,
      } : null,
    },
    spacing: {
      baseUnit: 8,
      scale: [4, 8, 12, 16, 24, 32, 48, 64, 96],
    },
    components: {
      buttons: {
        colors: buttonColors,
        style: buttonStyle,
      },
      cards: {
        shadowStyle: 'soft',
        borderRadius: '8px',
      },
      nav: {
        colors: brand.signals?.nav || [],
        style: 'sticky',
      },
      borderRadius: '8px',
    },
    layout: {
      style: businessContext.layoutStyle?.style || 'clean-grid',
      description: businessContext.layoutStyle?.description || '',
      responsive: {
        mobileNav: 'unknown',
        breakpoints: [],
      },
    },
    motion: {
      hasAnimations,
      style: hasAnimations ? 'moderate' : (hasTransitions ? 'minimal' : 'none'),
      speed: 'medium',
    },
    brand: {
      name: analysis?.brand_identity?.name || scraped.title || '',
      tone: analysis?.brand_identity?.tone || businessContext.targetEmotion?.primary || '',
      emotion: {
        primary: businessContext.targetEmotion?.primary || '',
        secondary: businessContext.targetEmotion?.secondary || '',
      },
      businessType: businessContext.businessType || '',
      audience: businessContext.audience || '',
      primaryConversionGoal: businessContext.primaryConversionGoal || '',
    },
    patternGaps,
    seo: {
      lighthouse: auditBefore ? {
        performance: auditBefore.performance,
        accessibility: auditBefore.accessibility,
        seo: auditBefore.seo,
        bestPractices: auditBefore['best-practices'],
      } : null,
      aeo: scraped.aeoResult ? {
        score: scraped.aeoResult.aeoScore,
        breakdown: scraped.aeoResult.breakdown,
      } : null,
    },
    images: {
      total: images.length,
      logos: images.filter(i => i.isLogo),
      heroes: images.filter(i => i.isHero && !i.isLogo),
    },
  };
}

/**
 * Validate a design system object against required fields.
 * Returns { valid: boolean, errors: string[] }.
 * Manual validation (no ajv dependency — P4 boring infrastructure).
 */
function validateDesignSystem(ds) {
  const errors = [];
  const required = ['version', 'source', 'colors', 'typography', 'spacing', 'components', 'layout', 'brand'];

  for (const field of required) {
    if (!ds[field]) errors.push(`Missing required field: ${field}`);
  }

  if (ds.version && ds.version !== '1.0.0') {
    errors.push(`Unsupported version: ${ds.version} (expected 1.0.0)`);
  }

  if (ds.source) {
    if (!ds.source.url) errors.push('Missing source.url');
    if (!ds.source.scrapedAt) errors.push('Missing source.scrapedAt');
    if (!ds.source.contentHash) errors.push('Missing source.contentHash');
  }

  if (ds.colors) {
    if (typeof ds.colors.hasClearBranding !== 'boolean') errors.push('colors.hasClearBranding must be boolean');
    if (!Array.isArray(ds.colors.primary)) errors.push('colors.primary must be array');
  }

  if (ds.typography) {
    if (typeof ds.typography.bodyFont !== 'string') errors.push('typography.bodyFont must be string');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Generate design-brief.md FROM a validated design system.
 * The brief is a human/LLM-readable rendering of the structured JSON.
 */
function renderDesignBrief(ds, strategyBriefMd) {
  const lines = ['# Design Brief\n'];

  // Audit scores
  if (ds.seo?.lighthouse) {
    const lh = ds.seo.lighthouse;
    lines.push('## Current Lighthouse Scores (targets to beat)');
    lines.push(`- Performance: ${lh.performance}/100`);
    lines.push(`- Accessibility: ${lh.accessibility}/100`);
    lines.push(`- SEO: ${lh.seo}/100`);
    lines.push(`- Best Practices: ${lh.bestPractices}/100`);
    lines.push('');
  }
  if (ds.seo?.aeo) {
    lines.push(`## Current AEO Score: ${ds.seo.aeo.score}/100`);
    lines.push('Breakdown: ' + JSON.stringify(ds.seo.aeo.breakdown, null, 2));
    lines.push('');
  }

  // Brand identity
  if (ds.colors.hasClearBranding) {
    lines.push('## Brand Identity (MUST PRESERVE)');
    lines.push('Clear branding detected on the original site. You MUST use these colors:');
    lines.push(`Primary brand colors: ${ds.colors.primary.join(', ')}`);
    if (ds.colors.semantic?.nav?.length) lines.push(`Nav/header colors: ${ds.colors.semantic.nav.join(', ')}`);
    if (ds.colors.semantic?.cta?.length) lines.push(`Button/CTA colors: ${ds.colors.semantic.cta.join(', ')}`);
    if (ds.colors.semantic?.heading?.length) lines.push(`Heading colors: ${ds.colors.semantic.heading.join(', ')}`);
    lines.push('');
    lines.push('DO NOT invent a new color scheme. The redesign must look like it belongs');
    lines.push('to the same brand. You may adjust shades/tints for contrast, but the core');
    lines.push('brand palette must be recognizable.');
    lines.push('');
  } else {
    lines.push('## Brand Identity');
    lines.push('No strong brand colors detected. You may propose a modern color palette,');
    lines.push('but keep it consistent with any colors present in the original design.');
    lines.push('');
  }

  // Typography
  if (ds.typography.recommended) {
    lines.push('## Typography');
    lines.push(`Recommended pairing: **${ds.typography.recommended.heading}** (headings) + **${ds.typography.recommended.body}** (body)`);
    lines.push(`Vibe: ${ds.typography.recommended.vibe || 'modern'}`);
    lines.push('');
  }

  // Images
  lines.push('## Images (MUST REUSE — NON-NEGOTIABLE)');
  lines.push('The original site has real images. You MUST use them. Do NOT invent image URLs.');
  lines.push('Read ./image-manifest.md for the complete list with exact URLs.');
  lines.push('');
  lines.push('Rules:');
  lines.push('- Use the EXACT src URLs below — do not modify, shorten, or guess URLs');
  lines.push('- Every section of your redesign should have visual content — no sparse/empty areas');
  lines.push(`- The site has ${ds.images?.total || 0} images — use at least as many in your redesign`);
  lines.push('- CSS gradients are supplementary decoration, NOT replacements for real photos');
  lines.push('- NEVER output an <img> tag with a made-up src — only URLs from this list');
  lines.push('');

  // Strategic design directives
  lines.push('## Strategic Design Directives');
  lines.push('Read ./strategy-brief.md for the full strategy brief. Key directives:\n');
  lines.push(`### Hero Section (Halo Effect — 50ms first impression)`);
  lines.push(`- Target emotion: **${ds.brand.emotion?.primary || 'trust'}** + **${ds.brand.emotion?.secondary || 'confidence'}**`);
  lines.push('- Single clear promise visible without scrolling');
  lines.push('');

  // Pattern gap directives
  if (ds.patternGaps?.length > 0) {
    lines.push('## Modern Design Patterns (apply these)');
    const highPri = ds.patternGaps.filter(g => g.priority === 'high');
    const medPri = ds.patternGaps.filter(g => g.priority === 'medium');
    const lowPri = ds.patternGaps.filter(g => g.priority === 'low');

    if (highPri.length) {
      lines.push('\n### Must-Have (high priority)');
      for (const g of highPri) lines.push(`- **${g.pattern}**: ${g.directive}`);
    }
    if (medPri.length) {
      lines.push('\n### Recommended (medium priority)');
      for (const g of medPri) lines.push(`- **${g.pattern}**: ${g.directive}`);
    }
    if (lowPri.length) {
      lines.push('\n### Nice-to-Have (low priority)');
      for (const g of lowPri) lines.push(`- **${g.pattern}**: ${g.directive}`);
    }
    lines.push('');
  }

  // Layout
  lines.push('## Layout');
  lines.push(`Style: ${ds.layout.style}`);
  if (ds.layout.description) lines.push(ds.layout.description);
  lines.push('');

  // Technical requirements
  lines.push('## Technical Requirements');
  lines.push('- Single self-contained HTML file with inline CSS');
  lines.push('- Mobile-responsive (test at 375px, 768px, 1440px)');
  lines.push('- Ensure WCAG AA contrast ratios (4.5:1 for text, 3:1 for large text)');
  lines.push('- Include JSON-LD structured data (Organization, FAQPage where appropriate)');
  lines.push('- Short answer paragraphs near headings for AI extractability');
  lines.push('');

  return lines.join('\n');
}

/**
 * Main handler: scrape → analyze → generate → store in Postgres.
 */
async function handler(task, context, agent) {
  const metadata = context.workItem?.metadata || {};
  const targetUrl = metadata.target_url;
  const visitorIntent = typeof metadata.visitor_intent === 'string'
    ? metadata.visitor_intent.trim()
    : '';

  if (!targetUrl) {
    return { success: false, reason: 'No target_url in work item metadata' };
  }

  // Create work directory for this job
  const jobDir = join(WORK_DIR, task.work_item_id);
  mkdirSync(jobDir, { recursive: true });

  const costBreakdown = { analyze: 0, generate: 0, total: 0 };
  let heartbeat = null;
  let cachedDesignSystem = null;

  try {
    // Start heartbeat immediately — reaper uses updated_at freshness
    heartbeat = startHeartbeat(task.work_item_id);

    // ── Step -1: Check design system cache (24h TTL) ─────────────
    try {
      const cacheResult = await queryWithRetry(
        `SELECT metadata->'design_system' as ds
         FROM agent_graph.work_items
         WHERE metadata->>'target_url' = $1
         AND status = 'completed'
         AND metadata->'design_system' IS NOT NULL
         AND updated_at > NOW() - INTERVAL '24 hours'
         ORDER BY updated_at DESC LIMIT 1`,
        [targetUrl]
      );
      if (cacheResult.rows?.length > 0 && cacheResult.rows[0].ds) {
        cachedDesignSystem = cacheResult.rows[0].ds;
        log.info(` Cache HIT: reusing design system from previous run (24h TTL)`);
      }
    } catch (err) {
      log.warn(` Cache check failed (non-fatal): ${err.message}`);
    }

    // ── Step 0: Audit original URL ──────────────────────────────
    let auditBefore = null;
    try {
      log.info(` Auditing original URL: ${targetUrl}`);
      auditBefore = await auditUrl(targetUrl);
      log.info(` Lighthouse before:`, auditBefore);
    } catch (err) {
      log.warn(` Lighthouse audit failed (non-fatal): ${err.message}`);
    }

    // ── Canonical AEO audit (best-effort, overlaps generation) ───
    // Official AEO score of the customer's LIVE site via the dedicated backend.
    // Kicked off now so the multi-minute scrape+generate hides its latency;
    // awaited just before the completion metadata write. Dormant (resolves
    // null) unless AEO_API_URL is configured. Never blocks or fails the job.
    let aeoCanonicalPromise = Promise.resolve(null);
    try {
      const aeoDomain = new URL(targetUrl).hostname;
      aeoCanonicalPromise = scoreDomainAEO(aeoDomain).catch(() => null);
    } catch { /* invalid URL — skip */ }

    // ── Step 1: Scrape ──────────────────────────────────────────
    heartbeat.setPhase('scraping');
    log.info(` Scraping ${targetUrl}`);
    let scraped;
    let firecrawlBrand = null;
    {
      const startMs = Date.now();
      try {
        await requirePermission(agent.agentId, 'tool', 'web_scrape');
        const result = await scrapeForBrand(targetUrl, jobDir, {
          frameworkColors: FRAMEWORK_COLORS,
          auditAEO: (page) => auditAEO(page),
          firecrawlEnabled: agent.config?.firecrawl?.enabled !== false,
          // Only pay the catalog-extraction cost (incl. Shopify probe) when an
          // intent was supplied — non-intent redesigns are unchanged.
          extractCatalog: !!visitorIntent,
        });
        scraped = result.scraped;
        firecrawlBrand = result.firecrawlBrand;
        logCapabilityInvocation({
          agentId: agent.agentId, resourceType: 'tool', resourceName: 'web_scrape',
          success: true, durationMs: Date.now() - startMs, workItemId: task.work_item_id,
        });
      } catch (err) {
        logCapabilityInvocation({
          agentId: agent.agentId, resourceType: 'tool', resourceName: 'web_scrape',
          success: false, durationMs: Date.now() - startMs, errorMessage: err.message,
          workItemId: task.work_item_id,
        });
        return { success: false, reason: `Scrape failed: ${err.message}` };
      }
    }

    // ── Step 2: Analyze ─────────────────────────────────────────
    heartbeat.setPhase('analyzing');
    log.info(` Analyzing design`);

    // INBOUND SAFETY GATE (P1, G8) — analyzeDesign is the FIRST LLM call on the
    // path and fuses UNTRUSTED scraped third-party content (title, meta, the
    // designData JSON, and a slice of the page HTML) into a Sonnet prompt. Screen
    // that exact concatenation through Model Armor BEFORE the LLM call so poisoned
    // scraped content never reaches the model. Same screen + fail-CLOSED behavior
    // (overridable via MODEL_ARMOR_FAIL_OPEN) as the intent-brief gate below. On
    // block: reject the job with the safetyBlock envelope (consistent with the
    // API-side inbound intent gate) rather than feed the generator poisoned input.
    {
      const metaKeywords = scraped.meta?.keywords || '';
      const analyzeInputs = [
        scraped.title || '',
        scraped.meta?.description || '',
        metaKeywords,
        (() => { try { return JSON.stringify(scraped.designData ?? {}); } catch { return ''; } })(),
        typeof scraped.html === 'string' ? scraped.html.slice(0, 8000) : '',
      ].join('\n\n');
      const scrapeVerdict = await screenRedesignInput(analyzeInputs, agent.agentId, {
        label: 'scraped_content (analyzeDesign input)',
      });
      if (!scrapeVerdict.ok) {
        log.warn(` Scraped content blocked by safety gate (${scrapeVerdict.reason}) — rejecting redesign (deny-by-default)`);
        return { success: false, reason: scrapeVerdict.reason, safetyBlock: scrapeVerdict.detail };
      }
    }

    const { analysis, costUsd: analyzeCost } = await analyzeDesign(agent, scraped, task.work_item_id);
    costBreakdown.analyze = analyzeCost;

    // Save analysis to work dir for the CLI session
    writeFileSync(join(jobDir, 'analysis.json'), JSON.stringify(analysis, null, 2));

    // ── Step 2.1: Extract business context ($0, pure JS) ─────────
    log.info(` Extracting business context`);
    const businessContext = extractBusinessContext(scraped, analysis, targetUrl);
    writeFileSync(join(jobDir, 'business-context.json'), JSON.stringify(businessContext, null, 2));
    log.info(` Business: type=${businessContext.businessType}, audience=${businessContext.audience}, goal=${businessContext.primaryConversionGoal}, emotion=${businessContext.targetEmotion.primary}+${businessContext.targetEmotion.secondary}`);
    if (businessContext.fontPairing) {
      log.info(` Typography: ${businessContext.fontPairing.heading} + ${businessContext.fontPairing.body} (${businessContext.fontPairing.vibe})`);
    }
    if (businessContext.layoutStyle) {
      log.info(` Layout: ${businessContext.layoutStyle.style}`);
    }

    // ── Step 2.4: Visitor-intent landing page (optional) ─────────
    // When the requester supplied a visitor intent, match it against the
    // scraped product catalog and write intent-brief.md, which flips the
    // generator into intent-targeted landing-page mode. Non-fatal; absence of
    // intent or catalog falls back to the normal homepage redesign.
    if (visitorIntent) {
      try {
        const catalog = Array.isArray(scraped.catalog) ? scraped.catalog : [];
        const { matched, ranked } = catalog.length > 0
          ? await matchProductsToIntent(visitorIntent, catalog)
          : { matched: [], ranked: false };
        const intentBrief = renderIntentBrief(visitorIntent, {
          matched,
          ranked,
          headings: scraped.seoElements?.headings || [],
        });

        // INBOUND SAFETY GATE (P1, G8) — defense in depth. visitor_intent is
        // already screened API-side, but the intent brief also fuses UNTRUSTED
        // scraped third-party content (catalog fields + page headings) into the
        // model-facing context. Screen the assembled brief through Model Armor
        // BEFORE it is written for the generator to read. On block: skip the
        // intent brief (fall back to plain homepage redesign) — do not feed
        // poisoned scraped content to the LLM. Fail-CLOSED in prod unless
        // MODEL_ARMOR_FAIL_OPEN is set.
        const briefVerdict = await screenRedesignInput(intentBrief, agent.agentId, {
          label: 'intent_brief (scraped content)',
        });
        if (!briefVerdict.ok) {
          log.warn(` Intent brief blocked by safety gate (${briefVerdict.reason}) — falling back to homepage redesign`);
        } else {
          writeFileSync(join(jobDir, 'intent-brief.md'), intentBrief);
          log.info(` Intent mode: "${visitorIntent}" → ${matched.length} products (catalog=${catalog.length}, ranked=${ranked})`);
        }
      } catch (err) {
        log.warn(` Intent matching failed (non-fatal): ${err.message}`);
      }
    }

    // ── Step 2.2: Generate strategy brief ($0, template) ─────────
    log.info(` Generating strategy brief`);
    const strategyBriefMd = generateStrategyBrief(businessContext, analysis);
    writeFileSync(join(jobDir, 'strategy-brief.md'), strategyBriefMd);

    // ── Step 2.3: Build structured design system (JSON) ──────────
    let extractedDesignSystem;
    if (cachedDesignSystem) {
      extractedDesignSystem = cachedDesignSystem;
      log.info(` Using cached design system (skipping extraction)`);
    } else {
      log.info(` Building design system artifact`);
      extractedDesignSystem = buildDesignSystem(scraped, analysis, businessContext, auditBefore);
      const validation = validateDesignSystem(extractedDesignSystem);
      if (!validation.valid) {
        log.warn(` Design system validation warnings: ${validation.errors.join(', ')}`);
      }
      log.info(` Design system: ${extractedDesignSystem.patternGaps.length} pattern gaps detected, branding=${extractedDesignSystem.colors.hasClearBranding}`);
    }
    writeFileSync(join(jobDir, 'design-system.json'), JSON.stringify(extractedDesignSystem, null, 2));

    // Enrich design system with Firecrawl brand data if available
    if (firecrawlBrand) {
      log.info(` Enriching design system with Firecrawl brand data`);
      if (firecrawlBrand.personality) extractedDesignSystem.brand.personality = firecrawlBrand.personality;
      if (firecrawlBrand.voice) extractedDesignSystem.brand.voice = firecrawlBrand.voice;
      writeFileSync(join(jobDir, 'design-system.json'), JSON.stringify(extractedDesignSystem, null, 2));
    }

    // Write brand context to DB for cross-executor sharing (P3 auditable)
    try {
      await query(
        `INSERT INTO content.brand_contexts (target_url, design_system, business_context, strategy_brief, lighthouse_before)
         VALUES ($1, $2, $3, $4, $5)`,
        [targetUrl, JSON.stringify(extractedDesignSystem), JSON.stringify(businessContext), strategyBriefMd, auditBefore ? JSON.stringify(auditBefore) : null]
      );
      log.info(` Brand context saved to DB for ${targetUrl}`);
    } catch (err) {
      log.warn(` Failed to save brand context (non-fatal): ${err.message}`);
    }

    // ── Step 2.5: Render design brief FROM design system ─────────
    let briefContent = renderDesignBrief(extractedDesignSystem, strategyBriefMd);

    // Append strategy directives not covered by renderDesignBrief
    const extraLines = [];
    extraLines.push('### Cognitive Fluency');
    extraLines.push('- ONE goal per section — each section should have exactly one purpose');
    extraLines.push('- Whitespace is a premium signal. Use padding >= 60px between sections');
    extraLines.push('- Visual hierarchy should tell the story even without reading details');
    extraLines.push('');
    if (businessContext.fontPairing) {
      const fp = businessContext.fontPairing;
      extraLines.push('### Typography (MUST USE)');
      extraLines.push(`- Heading font: **${fp.heading}** (weights: ${fp.weights.heading.join(', ')})`);
      extraLines.push(`- Body font: **${fp.body}** (weights: ${fp.weights.body.join(', ')})`);
      if (fp.accent) {
        extraLines.push(`- Accent font: **${fp.accent}** (weights: ${fp.weights.accent.join(', ')})`);
      }
      extraLines.push(`- Google Fonts link: \`${fp.googleFontsUrl}\``);
      extraLines.push('- Use `font-display: swap` for performance');
      extraLines.push('- Do NOT use any other fonts. This pairing was selected to match the brand emotion.');
      extraLines.push('');
    }
    if (businessContext.layoutStyle) {
      const ls = businessContext.layoutStyle;
      extraLines.push(`### Layout Style: ${ls.style}`);
      extraLines.push(ls.description);
      extraLines.push('');
    }
    extraLines.push('### Micro-Interactions (Peak-End Rule) — CSS only');
    extraLines.push('- CTA hover: `transform: translateY(-2px); box-shadow` transition');
    extraLines.push('- Card hover: subtle lift effect');
    extraLines.push('- `html { scroll-behavior: smooth }`');
    extraLines.push('- `:focus-visible` outlines on all interactive elements');
    extraLines.push('- Section fade-in animation (CSS `@keyframes`, no JS)');
    extraLines.push('- Button state transitions: `transition: background-color 0.2s, transform 0.2s`');
    extraLines.push('');
    extraLines.push('### Conversion Architecture');
    extraLines.push(`- Primary goal: **${businessContext.primaryConversionGoal}**`);
    extraLines.push('- Place social proof within one scroll of every CTA');
    extraLines.push('- Objection handling (FAQ/Why Us) section BEFORE the final CTA');
    extraLines.push('- At least one trust signal visible above the fold');
    extraLines.push('');
    extraLines.push('## Score Requirements (NON-NEGOTIABLE)');
    extraLines.push('Your redesign MUST score EQUAL OR BETTER on every metric:');
    if (auditBefore) {
      extraLines.push(`- SEO: must be >= ${auditBefore.seo}`);
      extraLines.push(`- Accessibility: must be >= ${auditBefore.accessibility}`);
      extraLines.push(`- Performance: must be >= ${auditBefore.performance}`);
      extraLines.push(`- Best Practices: must be >= ${auditBefore['best-practices']}`);
    }
    if (scraped.aeoResult) {
      extraLines.push(`- AEO: must be >= ${scraped.aeoResult.aeoScore}`);
    }
    extraLines.push('A regression on ANY metric is unacceptable.');
    extraLines.push('');
    extraLines.push('## SEO Preservation (NON-NEGOTIABLE)');
    extraLines.push('Read ./seo-head.html — it contains all SEO-critical <head> elements extracted from the original site.');
    extraLines.push('Copy EVERY element from seo-head.html into your redesign\'s <head> tag.');
    extraLines.push('This includes: title, meta description, canonical URL, OG tags, hreflang links, and JSON-LD structured data.');
    extraLines.push('You may ADD new structured data (e.g., FAQPage) but NEVER remove or modify the originals.');
    extraLines.push('JSON-LD <script type="application/ld+json"> tags are NOT executable scripts — they are required SEO data.');
    extraLines.push('');
    extraLines.push('## Improvement Directives');
    extraLines.push('- Use semantic HTML5 (header, nav, main, section, article, footer)');
    extraLines.push('- Proper heading hierarchy (single H1, H2s for sections, H3s for subsections)');
    extraLines.push('- Add alt text to all images');
    extraLines.push('- Use ARIA labels for interactive elements');
    extraLines.push('- Ensure WCAG AA contrast ratios (4.5:1 for text, 3:1 for large text)');
    extraLines.push('- Include JSON-LD structured data (Organization, FAQPage where appropriate)');
    extraLines.push('- Short answer paragraphs near headings for AI extractability');
    extraLines.push('');

    briefContent += '\n' + extraLines.join('\n');
    writeFileSync(join(jobDir, 'design-brief.md'), briefContent);

    // ── Step 2.6: Select components from library ─────────────────
    let selectedComponents = [];
    try {
      selectedComponents = selectComponents(extractedDesignSystem, strategyBriefMd);
      log.info(` Component library: selected ${selectedComponents.length} components (hash: ${getLibraryHash()})`);
    } catch (err) {
      log.warn(` Component selection failed (non-fatal): ${err.message}`);
    }

    // ── Step 2.7: Assemble blueprint ─────────────────────────────
    assembleBlueprint(jobDir, {
      designSystem: extractedDesignSystem,
      strategyBriefMd,
      businessContext,
      components: selectedComponents,
    });

    // ── Step 3: Generate from blueprint (single pass) ─────────────
    heartbeat.setPhase('generating');

    const claudeCodeConfig = agent.config?.claudeCode || {};
    const pipelineConfig = agent.config?.pipeline?.blueprint || agent.config?.pipeline?.generate || {};

    log.info(` Generating redesign from blueprint (single-pass)`);
    {
      const startMs = Date.now();
      await requirePermission(agent.agentId, 'subprocess', 'claude_cli');

      const genResult = await generateFromBlueprint(jobDir, {
        maxBudgetUsd: pipelineConfig.maxBudgetUsd || claudeCodeConfig.maxBudgetUsd || 2.50,
        model: pipelineConfig.model || claudeCodeConfig.model || 'sonnet',
        backend: pipelineConfig.backend || 'claude',
        allowedTools: pipelineConfig.allowedTools || claudeCodeConfig.allowedTools || ['Read', 'Write', 'Glob', 'Grep'],
        maxTurns: pipelineConfig.maxTurns || claudeCodeConfig.maxTurns || 35,
        timeoutMs: pipelineConfig.timeoutMs || 10 * 60 * 1000,
        extensions: pipelineConfig.extensions,
        allowedMcpServers: pipelineConfig.allowedMcpServers,
      });

      logCapabilityInvocation({
        agentId: agent.agentId, resourceType: 'subprocess', resourceName: 'claude_cli',
        success: !genResult.error && !genResult.isError, durationMs: Date.now() - startMs,
        errorMessage: genResult.error || null,
        workItemId: task.work_item_id,
        resultSummary: genResult.error ? null : `${genResult.numTurns} turns, $${genResult.costUsd?.toFixed(4)}`,
      });

      if (genResult.error || genResult.isError) {
        const errDetail = genResult.error || genResult.result || 'CLI error';
        log.error(` Blueprint generation failed: ${errDetail.slice(0, 500)}`);
        return { success: false, reason: `Generation failed: ${errDetail.slice(0, 200)}` };
      }

      costBreakdown.generate = genResult.costUsd || 0;
    }

    // Verify generation produced output
    if (!existsSync(join(jobDir, 'redesign.html'))) {
      return { success: false, reason: 'Blueprint generation did not produce redesign.html' };
    }

    // Read generated HTML
    let redesignHtml;
    try {
      redesignHtml = readFileSync(join(jobDir, 'redesign.html'), 'utf-8');
    } catch {
      return { success: false, reason: 'Could not read redesign.html after generation' };
    }

    // ── Step 3.5: Audit redesign (post-generation) ───────────────
    let auditAfter = null;
    let aeoAfter = null;
    try {
      log.info(` Auditing redesign output`);
      const localAudit = await auditLocalFile(join(jobDir, 'redesign.html'));
      auditAfter = localAudit.lighthouse;
      aeoAfter = localAudit.aeo;
      log.info(` Lighthouse after:`, auditAfter);
      log.info(` AEO after:`, aeoAfter);
    } catch (err) {
      log.warn(` Redesign audit failed (non-fatal): ${err.message}`);
    }

    // Log any regressions (informational — no automatic fix pass)
    const regressions = findRegressions(
      auditBefore, auditAfter,
      scraped.aeoResult?.aeoScore, aeoAfter?.aeoScore
    );
    if (regressions.length > 0) {
      log.warn(` Score regressions detected: ${regressions.map(r => `${r.label} ${r.before}→${r.after}`).join(', ')}`);
    } else if (auditBefore && auditAfter) {
      log.info(` No regressions — all scores equal or better`);
    }

    // OUTBOUND PUBLISH GATE (P1 deny-by-default, P2 infra-enforces).
    // The generated HTML is UNTRUSTED model output that will be served publicly.
    // Sanitize it (strip <script>, on* handlers, javascript: URLs, iframes) and
    // decide publish status. A page is 'published' ONLY if it clears the gate;
    // otherwise it is 'blocked' (persisted but withheld by the serve route).
    // stripScripts alone (script-tags only) is insufficient — replaced by the
    // fuller sanitizer + version-stamped publish flag.
    const publishGate = runPublishGate(redesignHtml);
    redesignHtml = publishGate.html;
    if (publishGate.publishStatus !== 'published') {
      log.warn(` Publish gate BLOCKED redesign output: ${publishGate.blockReason}`);
    }

    costBreakdown.total = costBreakdown.analyze + costBreakdown.generate;

    // ── Step 4: Store in Postgres ───────────────────────────────
    heartbeat.setPhase('storing');
    heartbeat.stop();

    // Read strategy rationale if Claude generated it
    let strategyRationale = null;
    try {
      if (existsSync(join(jobDir, 'strategy-rationale.md'))) {
        strategyRationale = readFileSync(join(jobDir, 'strategy-rationale.md'), 'utf-8');
      }
    } catch {}

    // Canonical AEO report of the live site (started before scrape). Resolves
    // null when the service is dormant/slow/down — the heuristic before/after
    // above is unaffected. Kept as a SEPARATE block (not merged into the
    // before/after delta) so the two engines are never mixed.
    const aeoReport = await aeoCanonicalPromise;
    if (aeoReport) {
      log.info(` AEO report attached: overall=${aeoReport.overallScore}`);
    }

    log.info(` Storing redesign HTML in work_item metadata`);
    await queryWithRetry(
      `UPDATE agent_graph.work_items
       SET metadata = metadata || $1::jsonb
       WHERE id = $2`,
      [
        JSON.stringify({
          html_output: redesignHtml,
          // Publish gate (P1 deny-by-default). The serve route refuses to render
          // any page that is not publish_status='published' at the current
          // safety_version, so unscreened/blocked output is never served.
          publish_status: publishGate.publishStatus,
          safety_version: publishGate.safetyVersion,
          publish_block_reason: publishGate.blockReason,
          aeo_report: aeoReport,
          cost_usd: costBreakdown.total,
          design_system: extractedDesignSystem,
          design_system_version: '1.0.0',
          design_analysis: analysis,
          business_context: businessContext,
          strategy_rationale: strategyRationale,
          audit_before: auditBefore ? { ...auditBefore, aeo: scraped.aeoResult?.aeoScore ?? null } : null,
          audit_after: auditAfter ? { ...auditAfter, aeo: aeoAfter?.aeoScore ?? null } : null,
          aeo_breakdown_before: scraped.aeoResult?.breakdown || null,
          aeo_breakdown_after: aeoAfter?.breakdown || null,
          score_comparison: (() => {
            if (!auditBefore || !auditAfter) return null;
            const result = {};
            const keys = ['performance', 'accessibility', 'seo', 'best-practices', 'aeo'];
            const afterWithAeo = { ...auditAfter, aeo: aeoAfter?.aeoScore ?? null };
            const beforeWithAeo = { ...auditBefore, aeo: scraped.aeoResult?.aeoScore ?? null };
            for (const k of keys) {
              const before = beforeWithAeo[k];
              const after = afterWithAeo[k];
              if (typeof before === 'number' && typeof after === 'number' && after >= before) {
                result[k] = { before, after, delta: after - before };
              }
            }
            return result;
          })(),
        }),
        task.work_item_id,
      ]
    );

    // Log CLI session to llm_invocations for audit trail (P3)
    try {
      const promptHash = createHash('sha256').update(targetUrl).digest('hex');
      const responseHash = createHash('sha256').update(redesignHtml.slice(0, 1000)).digest('hex');
      const idempotencyKey = `redesign-gen-${task.work_item_id}-${promptHash.slice(0, 16)}`;

      await queryWithRetry(
        `INSERT INTO agent_graph.llm_invocations
         (agent_id, task_id, model, input_tokens, output_tokens, cost_usd,
          prompt_hash, response_hash, latency_ms, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          agent.agentId, task.work_item_id, 'claude-sonnet-4-6',
          0, 0, costBreakdown.generate,
          promptHash, responseHash, 0, idempotencyKey,
        ]
      );
    } catch (err) {
      log.warn(` Failed to log to llm_invocations: ${err.message}`);
    }

    await publishEvent(
      'redesign_completed',
      `Website redesign completed for ${targetUrl}`,
      agent.agentId, task.work_item_id,
      { target_url: targetUrl, cost_usd: costBreakdown.total }
    );

    log.info(` Redesign complete for ${targetUrl} (cost: $${costBreakdown.total.toFixed(4)})`);

    // Send email notification if requested
    if (metadata.notify_email) {
      try {
        const previewUrl = `https://staqs.io/api/redesign/preview/${task.work_item_id}`;
        await sendRedesignEmail(metadata.notify_email, targetUrl, previewUrl, {
          auditBefore: auditBefore ? { ...auditBefore, aeo: scraped.aeoResult?.aeoScore ?? null } : null,
          auditAfter: auditAfter ? { ...auditAfter, aeo: aeoAfter?.aeoScore ?? null } : null,
        });
        log.info(` Notification email sent to ${metadata.notify_email}`);
      } catch (emailErr) {
        log.warn(` Failed to send notification email: ${emailErr.message}`);
      }
    }

    return {
      success: true,
      reason: `Redesign completed for ${targetUrl} (cost: $${costBreakdown.total.toFixed(4)})`,
      costUsd: costBreakdown.total,
    };
  } finally {
    // Ensure heartbeat is stopped even on early errors
    try { heartbeat?.stop(); } catch {}
    // Cleanup work directory (best-effort)
    try {
      const { rm } = await import('fs/promises');
      await rm(jobDir, { recursive: true, force: true });
    } catch {}
  }
}

export const redesignLoop = new AgentLoop('executor-redesign', handler);
