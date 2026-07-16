// Pure helpers for /today page sections.
// FR-34: My Tasks sort (overdue → due-today → priority → in_progress → created_at).
// FR-35: Today-in-Linear formatter (read-only Linear pull).
// FR-36: Quick Wins filter (size + assignee + relevance + non-terminal, cap 5).
//
// Per ADR-004: keep helpers framework-free so they can be tested under
// node:test without RTL or a bundler. ES module.

// ----- shared constants -----

const PRIORITY_RANK = {
  urgent: 4,
  high: 3,
  normal: 2,
  low: 1,
};

const TERMINAL_STATUSES = new Set(['done', 'skipped', 'not_for_us']);

const QUICK_WIN_SIZES = new Set(['quick', 'small']);

// Day buckets used by the My Tasks sort: 0 = overdue, 1 = due today, 2 = later/none.
const BUCKET_OVERDUE = 0;
const BUCKET_TODAY = 1;
const BUCKET_LATER = 2;

const MY_TASKS_CAP = 8;
const QUICK_WINS_CAP = 5;

// ----- date helpers -----

/**
 * Parse a YYYY-MM-DD-ish date string into a local-midnight Date.
 * Anything that doesn't yield a valid date returns null. We intentionally
 * normalise to local midnight so "due today" is a day comparison, not a
 * UTC timestamp comparison.
 */
function parseDueDate(value) {
  if (!value) return null;
  // Accept both 'YYYY-MM-DD' and full ISO timestamps — Linear and
  // human_tasks emit both shapes depending on the column type.
  const m = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(y, mo - 1, d);
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Bucket a task into overdue / today / later based on its due_date relative
 * to `now`. Tasks without a due_date land in "later" (FR-22 in spec text:
 * no due_date is later than due-today).
 */
function dueBucket(task, now) {
  const due = parseDueDate(task && task.due_date);
  if (!due) return BUCKET_LATER;
  const todayStart = startOfDay(now);
  const dueStart = startOfDay(due);
  if (dueStart.getTime() < todayStart.getTime()) return BUCKET_OVERDUE;
  if (dueStart.getTime() === todayStart.getTime()) return BUCKET_TODAY;
  return BUCKET_LATER;
}

function priorityScore(task) {
  const p = task && task.priority;
  return PRIORITY_RANK[p] ?? 0;
}

function inProgressFirst(task) {
  // Return 0 for in_progress, 1 otherwise — smaller sorts first.
  return task && task.status === 'in_progress' ? 0 : 1;
}

function createdAtMs(task) {
  if (!task || !task.created_at) return 0;
  const t = new Date(task.created_at).getTime();
  return Number.isNaN(t) ? 0 : t;
}

// ============================================================================
// sortMyTasks — FR-34
// ============================================================================

/**
 * Sort the operator's tasks for the /today My Tasks section.
 *
 * Precedence:
 *  1. Overdue (due_date < today)
 *  2. Due today
 *  3. Priority desc (urgent > high > normal > low)
 *  4. in_progress first within same priority
 *  5. created_at ascending (older first)
 *
 * Capped at 8 items.
 *
 * @param {Array} tasks
 * @param {Date} [now]
 * @returns {Array}
 */
export function sortMyTasks(tasks, now = new Date()) {
  if (!Array.isArray(tasks) || tasks.length === 0) return [];

  const decorated = tasks.map((task, idx) => ({
    task,
    idx,
    bucket: dueBucket(task, now),
    pri: priorityScore(task),
    ipf: inProgressFirst(task),
    created: createdAtMs(task),
  }));

  decorated.sort((a, b) => {
    if (a.bucket !== b.bucket) return a.bucket - b.bucket;
    if (a.pri !== b.pri) return b.pri - a.pri; // desc
    if (a.ipf !== b.ipf) return a.ipf - b.ipf;
    if (a.created !== b.created) return a.created - b.created; // asc
    return a.idx - b.idx; // stable
  });

  return decorated.slice(0, MY_TASKS_CAP).map((d) => d.task);
}

// ============================================================================
// filterQuickWins — FR-36
// ============================================================================

/**
 * Filter the Quick Wins strip for /today.
 *
 *  - size ∈ {quick, small}
 *  - (assignee = me) OR (unassigned AND relevance_score >= 0.6)
 *  - not in terminal status (done / skipped / not_for_us)
 *
 * Sort: priority desc, due_date asc (nulls last), created_at desc (newest first).
 * Capped at 5 items.
 *
 * @param {Array} tasks
 * @param {string|null} currentUserId
 * @param {Date} [now]
 * @returns {Array}
 */
export function filterQuickWins(tasks, currentUserId, now = new Date()) {
  void now; // currently unused; kept in signature for symmetry + future use
  if (!Array.isArray(tasks) || tasks.length === 0) return [];

  const filtered = tasks.filter((task) => {
    if (!task) return false;
    if (!QUICK_WIN_SIZES.has(task.size)) return false;
    if (TERMINAL_STATUSES.has(task.status)) return false;
    const assignee = task.assignee_contact_id ?? null;
    if (assignee === currentUserId && currentUserId != null) return true;
    if (assignee == null && (task.relevance_score ?? 0) >= 0.6) return true;
    return false;
  });

  filtered.sort((a, b) => {
    const ap = priorityScore(a);
    const bp = priorityScore(b);
    if (ap !== bp) return bp - ap; // priority desc

    const ad = parseDueDate(a.due_date);
    const bd = parseDueDate(b.due_date);
    const at = ad ? ad.getTime() : Number.POSITIVE_INFINITY;
    const bt = bd ? bd.getTime() : Number.POSITIVE_INFINITY;
    if (at !== bt) return at - bt; // due_date asc (nulls last)

    const ac = createdAtMs(a);
    const bc = createdAtMs(b);
    return bc - ac; // created_at desc (newest first)
  });

  return filtered.slice(0, QUICK_WINS_CAP);
}

// ============================================================================
// formatTodayInLinearItem — FR-35
// ============================================================================

/**
 * Pure formatter for a Linear-only issue (not in inbox.human_tasks) shown
 * in the "Today in Linear" section of /today. Read-only.
 *
 * Input shape mirrors Linear's GraphQL Issue type — accepts both camelCase
 * (Linear) and snake_case (DB) variants so callers don't have to translate.
 *
 * Returns `{summary, link}`.
 *  - `summary` is a single-line human-readable string built from identifier
 *    + title + optional priority + optional due date.
 *  - `link` is the Linear issue URL.
 */
export function formatTodayInLinearItem(issue) {
  if (!issue || typeof issue !== 'object') {
    return { summary: '', link: '' };
  }

  const identifier = issue.identifier || issue.id || '';
  const title = (issue.title || '').trim();
  const priority = issue.priority ?? null;
  const dueDate = issue.dueDate ?? issue.due_date ?? null;
  const link = issue.url || '';

  const parts = [];
  if (identifier) parts.push(String(identifier));
  if (title) parts.push(title);

  const tags = [];
  if (priority && typeof priority === 'string' && priority.trim()) {
    tags.push(priority.trim());
  }
  if (dueDate) {
    const parsed = parseDueDate(dueDate);
    if (parsed) {
      const iso = `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`;
      tags.push(`due ${iso}`);
    }
  }

  let summary = parts.join(' — ');
  if (tags.length > 0) {
    summary = summary ? `${summary} (${tags.join(', ')})` : `(${tags.join(', ')})`;
  }

  return { summary, link };
}
