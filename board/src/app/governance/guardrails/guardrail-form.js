// Pure helpers backing the Settings → LLM Guardrails editor UI (FR-22).
//
// All functions are side-effect free and operate on plain JS values, so they
// can be unit-tested under node:test without a DOM or React harness.

/**
 * @typedef {Object} GuardrailFormInput
 * @property {string} [kind]         - 'push' or 'pull'
 * @property {string} [prompt_text]  - the guardrail prompt body
 * @property {*}      [mapping]      - state_id → kanban status map (must be plain object)
 */

/**
 * @typedef {Object} GuardrailFormResult
 * @property {boolean} valid
 * @property {Record<string,string>} errors
 */

const VALID_KINDS = new Set(['push', 'pull']);
const PROMPT_MAX = 2000;

/**
 * Returns true if v is a plain object literal (not null, not array, not other
 * built-in like Map/Date/RegExp). We accept any object whose prototype is
 * Object.prototype or null — that's the shape JSON.parse produces and the
 * shape the form's controlled state uses.
 *
 * @param {*} v
 * @returns {boolean}
 */
function isPlainObject(v) {
  if (v === null || typeof v !== 'object') return false;
  if (Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Validate a guardrail form payload. Collects ALL errors (never short-circuits)
 * so the editor can surface every problem in one render.
 *
 * @param {GuardrailFormInput} input
 * @returns {GuardrailFormResult}
 */
export function validateGuardrailForm(input) {
  const errors = {};
  const { kind, prompt_text, mapping } = input || {};

  if (!kind || !VALID_KINDS.has(kind)) {
    errors.kind = 'kind must be push or pull';
  }

  if (typeof prompt_text !== 'string' || prompt_text.trim().length === 0) {
    errors.prompt_text = 'prompt_text is required';
  } else if (prompt_text.length > PROMPT_MAX) {
    errors.prompt_text = `prompt_text must be ${PROMPT_MAX} characters or fewer`;
  }

  if (!isPlainObject(mapping)) {
    errors.mapping = 'mapping must be a plain object';
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * @typedef {Object} MappingDiffChange
 * @property {string} stateId
 * @property {string} from
 * @property {string} to
 */

/**
 * @typedef {Object} MappingDiff
 * @property {string[]} added
 * @property {string[]} removed
 * @property {MappingDiffChange[]} changed
 */

/**
 * Diff two mapping objects (state_id → status). Pure set/membership math —
 * does NOT sort buckets; callers that care about order sort their own copy.
 *
 * @param {Record<string,string>} prev
 * @param {Record<string,string>} next
 * @returns {MappingDiff}
 */
export function diffGuardrailMapping(prev, next) {
  const prevObj = prev || {};
  const nextObj = next || {};

  const added = [];
  const removed = [];
  const changed = [];

  for (const key of Object.keys(nextObj)) {
    if (!Object.prototype.hasOwnProperty.call(prevObj, key)) {
      added.push(key);
    } else if (prevObj[key] !== nextObj[key]) {
      changed.push({ stateId: key, from: prevObj[key], to: nextObj[key] });
    }
  }

  for (const key of Object.keys(prevObj)) {
    if (!Object.prototype.hasOwnProperty.call(nextObj, key)) {
      removed.push(key);
    }
  }

  return { added, removed, changed };
}

/**
 * @typedef {Object} LineDiffEntry
 * @property {'add'|'remove'} type
 * @property {string} text
 */

/**
 * @typedef {Object} PromptDiff
 * @property {boolean} changed
 * @property {LineDiffEntry[]} lineDiff
 */

/**
 * Line-by-line diff of two prompt strings. Simple positional comparison:
 * for each index i, if prev[i] !== next[i] we emit a remove(prev[i]) and an
 * add(next[i]); if one side is shorter, the extra lines on the other side
 * become pure adds or removes. Unchanged lines are omitted entirely (no
 * 'context' entries — see contract in test file).
 *
 * @param {string} prev
 * @param {string} next
 * @returns {PromptDiff}
 */
export function diffGuardrailPrompt(prev, next) {
  const prevStr = prev == null ? '' : String(prev);
  const nextStr = next == null ? '' : String(next);

  if (prevStr === nextStr) {
    return { changed: false, lineDiff: [] };
  }

  const prevLines = prevStr.split('\n');
  const nextLines = nextStr.split('\n');
  const max = Math.max(prevLines.length, nextLines.length);
  const lineDiff = [];

  for (let i = 0; i < max; i++) {
    const p = i < prevLines.length ? prevLines[i] : undefined;
    const n = i < nextLines.length ? nextLines[i] : undefined;
    if (p === n) continue;
    if (p !== undefined && p !== n) {
      lineDiff.push({ type: 'remove', text: p });
    }
    if (n !== undefined && n !== p) {
      lineDiff.push({ type: 'add', text: n });
    }
  }

  return { changed: lineDiff.length > 0, lineDiff };
}
