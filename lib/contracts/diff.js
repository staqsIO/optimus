/**
 * Version-to-version diff for contract bodies.
 *
 * Bodies are stored as TipTap-emitted HTML. We strip the markup down to
 * paragraph-segmented plaintext, do a coarse LCS at the paragraph level,
 * then a fine word-level LCS within each paragraph that was replaced.
 *
 * Two-stage diffing keeps the LCS table small (typical contracts have
 * 30–80 paragraphs and a few hundred words per paragraph) so we don't
 * allocate a 5000×5000 dp table for a small structural edit.
 */

function stripHtmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<br\s*\/?>(?!\s*<)/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre)\s*>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitParagraphs(text) {
  return text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
}

function tokenizeWords(text) {
  return text.match(/\S+|\s+/g) || [];
}

// Standard LCS-based diff. Returns ops [{type:'eq'|'del'|'add', a?, b?}].
// O(m*n) time and space — callers must keep inputs bounded.
function diffArrays(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push({ type: 'eq', a: a[i], b: b[j] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', a: a[i] });
      i++;
    } else {
      ops.push({ type: 'add', b: b[j] });
      j++;
    }
  }
  while (i < m) ops.push({ type: 'del', a: a[i++] });
  while (j < n) ops.push({ type: 'add', b: b[j++] });
  return ops;
}

function diffWords(aText, bText) {
  return diffArrays(tokenizeWords(aText), tokenizeWords(bText));
}

function countWords(text) {
  return (text.match(/\S+/g) || []).length;
}

/**
 * Word-token cap on a single paragraph word-diff. If either side blows past
 * the cap we degrade to a whole-paragraph replace, so a pathological huge
 * paragraph can't pin a CPU.
 */
const WORD_DIFF_CAP = 4000;

/**
 * Compute a structured diff between two contract bodies.
 *
 * @param {string} aHtml — older version body (HTML)
 * @param {string} bHtml — newer version body (HTML)
 * @returns {{ blocks: Array, stats: { added: number, removed: number, paragraphs: { added: number, removed: number, changed: number, unchanged: number } } }}
 *
 * blocks is a sequence of:
 *  - { type: 'eq',      text: string }
 *  - { type: 'add',     text: string }
 *  - { type: 'del',     text: string }
 *  - { type: 'replace', words: [{ type: 'eq'|'add'|'del', a?, b? }] }
 */
export function diffContractBodies(aHtml, bHtml) {
  const aPars = splitParagraphs(stripHtmlToText(aHtml));
  const bPars = splitParagraphs(stripHtmlToText(bHtml));

  const parOps = diffArrays(aPars, bPars);

  const blocks = [];
  const parStats = { added: 0, removed: 0, changed: 0, unchanged: 0 };

  for (let k = 0; k < parOps.length; k++) {
    const op = parOps[k];
    const next = parOps[k + 1];
    if (op.type === 'del' && next && next.type === 'add') {
      const aWords = countWords(op.a);
      const bWords = countWords(next.b);
      if (aWords + bWords <= WORD_DIFF_CAP) {
        blocks.push({ type: 'replace', words: diffWords(op.a, next.b) });
      } else {
        blocks.push({ type: 'del', text: op.a });
        blocks.push({ type: 'add', text: next.b });
      }
      parStats.changed += 1;
      k += 1;
      continue;
    }
    if (op.type === 'eq') {
      blocks.push({ type: 'eq', text: op.a });
      parStats.unchanged += 1;
    } else if (op.type === 'del') {
      blocks.push({ type: 'del', text: op.a });
      parStats.removed += 1;
    } else {
      blocks.push({ type: 'add', text: op.b });
      parStats.added += 1;
    }
  }

  const stats = { added: 0, removed: 0, paragraphs: parStats };
  for (const block of blocks) {
    if (block.type === 'add') stats.added += countWords(block.text);
    else if (block.type === 'del') stats.removed += countWords(block.text);
    else if (block.type === 'replace') {
      for (const w of block.words) {
        if (w.type === 'add') stats.added += countWords(w.b);
        else if (w.type === 'del') stats.removed += countWords(w.a);
      }
    }
  }

  return { blocks, stats };
}
