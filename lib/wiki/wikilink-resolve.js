/**
 * Shared wikilink resolution helpers for SQL patterns and multi-scope slug disambiguation.
 */

/**
 * Escape a wiki slug fragment for PostgreSQL ~ / ~* regex (POSIX), so only literal [[slug]] matches.
 */
export function escapePostgresRegex(str) {
  return String(str).replace(/[\\.*+?^[\]{}()|]/g, '\\$&');
}

/**
 * Regex bodies for backlinks: exact close `[[slug]]` or pipe form `[[slug|…`.
 * Caller passes these to `content ~* $n` in order.
 */
export function wikiBacklinkRegexPatterns(slug) {
  const esc = escapePostgresRegex(slug);
  return {
    exactClose: `\\[\\[${esc}\\]\\]`,
    pipeOpen: `\\[\\[${esc}\\|`,
  };
}

/**
 * When several wiki_pages share the same slug, prefer same project as referrer, then org-wide, then any.
 *
 * @param {Array<{ project_id?: string | null }>} candidates
 * @param {string | null | undefined} currentProjectId
 * @returns {object | null}
 */
export function pickResolvedWikiCandidate(candidates, currentProjectId) {
  if (!candidates?.length) return null;
  if (candidates.length === 1) return candidates[0];
  const currentPid = currentProjectId != null ? String(currentProjectId) : null;
  const same = candidates.filter(
    (c) => (c.project_id != null ? String(c.project_id) : null) === currentPid
  );
  if (same[0]) return same[0];
  const org = candidates.find((c) => c.project_id == null);
  if (org) return org;
  return candidates[0];
}
