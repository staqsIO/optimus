/**
 * Lightweight fuzzy matcher for command palette search.
 * Returns a score (0 = no match, higher = better match).
 */
export function fuzzyMatch(
  query: string,
  target: string,
  keywords?: string[],
): number {
  if (!query) return 1; // empty query matches everything (low score)

  const q = query.toLowerCase();
  const t = target.toLowerCase();

  // Exact match
  if (t === q) return 100;

  // Starts with query
  if (t.startsWith(q)) return 80;

  // Word boundary match (e.g. "kb" matches "Knowledge Base" via initials,
  // or "pipe" matches word start in "Pipeline")
  const words = t.split(/[\s\-_]+/);
  if (words.some((w) => w.startsWith(q))) return 60;

  // Substring match
  if (t.includes(q)) return 40;

  // Keyword match
  if (keywords?.some((kw) => kw.toLowerCase().includes(q))) return 30;

  return 0;
}
