import type { DiffLine } from "@/components/workstation/types";

/**
 * Compute a line-level diff between two texts using LCS.
 * Returns DiffLine[] with equal/add/remove markers and line numbers.
 */
export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const n = oldLines.length;
  const m = newLines.length;

  // Build LCS table
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array(m + 1).fill(0)
  );
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to produce diff
  const result: DiffLine[] = [];
  let i = n;
  let j = m;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.push({
        type: "equal",
        content: oldLines[i - 1],
        oldLineNo: i,
        newLineNo: j,
      });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({
        type: "add",
        content: newLines[j - 1],
        newLineNo: j,
      });
      j--;
    } else {
      result.push({
        type: "remove",
        content: oldLines[i - 1],
        oldLineNo: i,
      });
      i--;
    }
  }

  return result.reverse();
}

/**
 * Stats from a diff — counts of added and removed lines.
 */
export function computeDiffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.type === "add") added++;
    else if (line.type === "remove") removed++;
  }
  return { added, removed };
}

/**
 * A group of diff lines — either visible lines or a collapsed block of unchanged lines.
 */
export interface DiffGroup {
  type: "visible" | "collapsed";
  lines: DiffLine[];
}

/**
 * Group consecutive equal lines, collapsing runs longer than 2*contextLines
 * into an expandable "N lines unchanged" block. Changed lines and their
 * surrounding context (contextLines before and after) remain visible.
 */
export function groupDiffLines(lines: DiffLine[], contextLines = 3): DiffGroup[] {
  if (lines.length === 0) return [];

  // Find indices of all changed lines
  const changedIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].type !== "equal") changedIndices.push(i);
  }

  // If no changes or few lines, show everything
  if (changedIndices.length === 0 || lines.length <= contextLines * 2 + 5) {
    return [{ type: "visible", lines }];
  }

  // Build a set of visible line indices (changed lines + context)
  const visible = new Set<number>();
  for (const idx of changedIndices) {
    for (let i = Math.max(0, idx - contextLines); i <= Math.min(lines.length - 1, idx + contextLines); i++) {
      visible.add(i);
    }
  }
  // Always show first and last few lines
  for (let i = 0; i < Math.min(contextLines, lines.length); i++) visible.add(i);
  for (let i = Math.max(0, lines.length - contextLines); i < lines.length; i++) visible.add(i);

  const groups: DiffGroup[] = [];
  let i = 0;
  while (i < lines.length) {
    if (visible.has(i)) {
      const visibleLines: DiffLine[] = [];
      while (i < lines.length && visible.has(i)) {
        visibleLines.push(lines[i]);
        i++;
      }
      groups.push({ type: "visible", lines: visibleLines });
    } else {
      const collapsedLines: DiffLine[] = [];
      while (i < lines.length && !visible.has(i)) {
        collapsedLines.push(lines[i]);
        i++;
      }
      groups.push({ type: "collapsed", lines: collapsedLines });
    }
  }

  return groups;
}

/**
 * For a "create" file, generate DiffLine[] where every line is an "add".
 */
export function createFileAsAdditions(content: string): DiffLine[] {
  return content.split("\n").map((line, i) => ({
    type: "add" as const,
    content: line,
    newLineNo: i + 1,
  }));
}

/**
 * djb2 hash — returns hex string. Used for projection cache keys.
 */
export function contentHash(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
}
