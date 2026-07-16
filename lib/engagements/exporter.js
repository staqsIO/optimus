/**
 * Spec exporters — build the full living-spec document in different
 * output formats. All exporters share the same `loadSpecForExport` to
 * pull engagement + sections in order, so .md / .docx / Google Doc all
 * see the same content.
 *
 * Markdown is the canonical source; DOCX and Google Doc paths convert
 * from markdown (via marked → HTML → respective converter).
 */

import { getEngagement, ensureSpec, listSections, SYSTEM_PRINCIPAL } from './db.js';

/**
 * Load the data needed to export a spec.
 * Throws if the engagement doesn't exist or has no synthesized sections.
 */
export async function loadSpecForExport(engagementId) {
  const engagement = await getEngagement(engagementId, { principal: SYSTEM_PRINCIPAL });
  if (!engagement) {
    const err = new Error('engagement not found');
    err.statusCode = 404;
    throw err;
  }
  const spec = await ensureSpec(engagementId);
  const sections = await listSections(spec.id);
  if (sections.length === 0) {
    const err = new Error('this spec has no sections yet — run Re-synthesize first');
    err.statusCode = 422;
    err.code = 'NO_SECTIONS';
    throw err;
  }
  return { engagement, spec, sections };
}

/**
 * Render a spec as Markdown.
 *
 * Output shape:
 *   # <engagement name>
 *   > Client: <client> · Kind: <kind> · Spec v<version> · Synthesized <date>
 *
 *   ## <section title>
 *
 *   <body>
 *
 *   ## <section title>
 *
 *   <body>
 *   ...
 */
export function renderSpecAsMarkdown({ engagement, spec, sections }) {
  const lines = [];
  lines.push(`# ${engagement.name}`);

  const metaParts = [];
  if (engagement.client) metaParts.push(`Client: ${engagement.client}`);
  if (engagement.is_master) metaParts.push('Role: Master spec (baseline standards)');
  else metaParts.push(`Kind: ${engagement.kind}`);
  metaParts.push(`Spec v${spec.version}`);
  if (spec.last_synth_at) {
    metaParts.push(`Synthesized ${new Date(spec.last_synth_at).toISOString().slice(0, 19).replace('T', ' ')} UTC`);
  }
  lines.push('');
  lines.push(`> ${metaParts.join(' · ')}`);
  lines.push('');

  for (const s of sections) {
    lines.push(`## ${s.title}`);
    lines.push('');
    lines.push(s.body || '_(empty)_');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Convenience: load + render in one call.
 */
export async function exportSpecAsMarkdown(engagementId) {
  const data = await loadSpecForExport(engagementId);
  return {
    markdown: renderSpecAsMarkdown(data),
    engagement: data.engagement,
    spec: data.spec,
  };
}

/**
 * Filename slug for download Content-Disposition.
 *   "Acme Marketing Site" → "acme-marketing-site-spec-v3.md"
 */
export function specFilenameBase(engagement, spec) {
  const slug = String(engagement.name || 'spec')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'spec';
  return `${slug}-spec-v${spec.version}`;
}
