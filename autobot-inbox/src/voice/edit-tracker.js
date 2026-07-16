import { query } from '../db.js';

/**
 * Edit tracker: records board edits as G4 training data.
 * D4: Edit deltas are append-only (immutable triggers). Most valuable table in the system.
 * Every Eric edit is a signal for voice learning improvement.
 */

// Guard against concurrent auto-rebuilds (single-process, no mutex needed)
let _rebuildInProgress = false;

/**
 * Record an edit delta when Eric modifies a draft.
 * @param {Object} opts
 * @param {string} opts.draftId - Draft that was edited
 * @param {string} opts.originalBody - AI-generated draft
 * @param {string} opts.editedBody - Eric's edited version
 * @param {string} opts.recipient - Email recipient
 * @param {string} [opts.subject] - Email subject
 * @param {string} [opts.triageCategory] - Triage classification
 */
export async function recordEditDelta({
  draftId,
  emailId,
  originalBody,
  editedBody,
  recipient,
  subject = null,
  triageCategory = null,
}) {
  // Compute diff
  const diff = computeDiff(originalBody, editedBody);
  const editType = classifyEdit(originalBody, editedBody, diff);
  const editMagnitude = computeMagnitude(originalBody, editedBody);

  await query(
    `INSERT INTO voice.edit_deltas
     (draft_id, message_id, original_body, edited_body, diff, recipient, subject, triage_category, edit_type, edit_magnitude)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [draftId, emailId, originalBody, editedBody, diff, recipient, subject, triageCategory, editType, editMagnitude]
  );

  console.log(`[edit-tracker] Recorded edit delta: type=${editType}, magnitude=${editMagnitude}`);

  // Check if profiles should be rebuilt after this edit.
  // Dynamic import to break circular dependency: edit-tracker → profile-builder → analyzeEditDeltas
  // (profile-builder calls analyzeEditDeltas which lives here conceptually, but the rebuild
  // trigger here needs shouldRebuild/rebuildAllProfiles from profile-builder).
  const { shouldRebuild, rebuildAllProfiles } = await import('./profile-builder.js');
  const needsRebuild = await shouldRebuild('global');
  if (needsRebuild && !_rebuildInProgress) {
    _rebuildInProgress = true;
    rebuildAllProfiles().then(stats => {
      console.log(`[edit-tracker] Auto-rebuild triggered: ${stats.profilesRebuilt} profiles rebuilt from ${stats.deltasAnalyzed} deltas (${stats.elapsedMs}ms)`);
    }).catch(err => {
      console.error(`[edit-tracker] Auto-rebuild failed:`, err.message);
    }).finally(() => {
      _rebuildInProgress = false;
    });
  }

  return { editType, editMagnitude };
}

/**
 * Get recent edit examples for prompt injection into the responder.
 * Returns 2-3 high-magnitude edits as original→edited pairs.
 * Uses a 90-day recency window. Edit deltas are human corrections by
 * definition, so AI_PIPELINE_CUTOFF (used in few-shot-selector for sent
 * emails) does not apply here — every edit is a valid training signal.
 * @param {string} [recipient] - Scope to recipient (falls back to global)
 * @param {number} [limit] - Max examples (default 3)
 */
export async function getRecentEditExamples(recipient = null, limit = 3) {
  // Try recipient-scoped first
  if (recipient) {
    const recipientResult = await query(
      `SELECT original_body, edited_body, edit_type, edit_magnitude
       FROM voice.edit_deltas
       WHERE recipient = $1
         AND created_at >= CURRENT_DATE - interval '90 days'
         AND edit_magnitude >= 0.1
       ORDER BY edit_magnitude DESC, created_at DESC
       LIMIT $2`,
      [recipient, limit]
    );
    if (recipientResult.rows.length > 0) {
      return recipientResult.rows.map(formatEditExample);
    }
  }

  // Fallback to global (all recipients)
  const globalResult = await query(
    `SELECT original_body, edited_body, edit_type, edit_magnitude
     FROM voice.edit_deltas
     WHERE created_at >= CURRENT_DATE - interval '90 days'
       AND edit_magnitude >= 0.1
     ORDER BY edit_magnitude DESC, created_at DESC
     LIMIT $1`,
    [limit]
  );

  return globalResult.rows.map(formatEditExample);
}

function formatEditExample(row) {
  // Extract the most instructive snippet (first changed line or first ~100 chars)
  const origLines = (row.original_body || '').split('\n').filter(l => l.trim());
  const editLines = (row.edited_body || '').split('\n').filter(l => l.trim());

  let originalSnippet = '';
  let editedSnippet = '';

  // Find the first differing line for a focused example
  for (let i = 0; i < Math.max(origLines.length, editLines.length); i++) {
    const orig = (origLines[i] || '').trim();
    const edit = (editLines[i] || '').trim();
    if (orig !== edit && orig && edit) {
      originalSnippet = orig.slice(0, 120);
      editedSnippet = edit.slice(0, 120);
      break;
    }
  }

  // Fallback: use first lines if no diff found at line level
  if (!originalSnippet) {
    originalSnippet = origLines[0]?.slice(0, 120) || '';
    editedSnippet = editLines[0]?.slice(0, 120) || '';
  }

  return {
    original_snippet: originalSnippet,
    edited_snippet: editedSnippet,
    edit_type: row.edit_type,
  };
}

/**
 * Get the current edit rate over a rolling window.
 */
export async function getEditRate(days = 14) {
  const result = await query(
    `SELECT
       COUNT(*) FILTER (WHERE board_action = 'edited') AS edited,
       COUNT(*) AS total
     FROM agent_graph.action_proposals
     WHERE board_action IS NOT NULL
       AND acted_at >= CURRENT_DATE - $1 * interval '1 day'`,
    [days]
  );

  const { edited, total } = result.rows[0];
  return {
    edited: parseInt(edited),
    total: parseInt(total),
    rate: total > 0 ? (parseInt(edited) / parseInt(total)) : 0,
  };
}

function computeDiff(original, edited) {
  // Simple line-level diff
  const origLines = original.split('\n');
  const editLines = edited.split('\n');
  const diffs = [];

  const maxLen = Math.max(origLines.length, editLines.length);
  for (let i = 0; i < maxLen; i++) {
    const origLine = origLines[i] || '';
    const editLine = editLines[i] || '';
    if (origLine !== editLine) {
      diffs.push(`- ${origLine}`);
      diffs.push(`+ ${editLine}`);
    }
  }

  return diffs.join('\n');
}

function classifyEdit(original, edited, diff) {
  const diffLines = diff.split('\n').length;
  const totalLines = Math.max(original.split('\n').length, edited.split('\n').length);
  const changeRatio = diffLines / (totalLines * 2);

  if (changeRatio < 0.1) return 'minor';
  if (changeRatio > 0.5) return 'major';

  // Check if mostly structural (line reordering, paragraph changes)
  const origWords = new Set(original.toLowerCase().match(/\b\w+\b/g) || []);
  const editWords = new Set(edited.toLowerCase().match(/\b\w+\b/g) || []);
  const wordOverlap = [...origWords].filter(w => editWords.has(w)).length / Math.max(origWords.size, 1);

  if (wordOverlap > 0.9) return 'structure';
  if (wordOverlap > 0.7) return 'tone';
  return 'content';
}

function computeMagnitude(original, edited) {
  const origLen = original.length;
  const editLen = edited.length;
  if (origLen === 0) return 1.0;

  // Levenshtein-ish: character-level change ratio
  const maxLen = Math.max(origLen, editLen);

  // Simple approximation: changed characters / total
  let changes = 0;
  const minLen = Math.min(origLen, editLen);
  for (let i = 0; i < minLen; i++) {
    if (original[i] !== edited[i]) changes++;
  }
  changes += Math.abs(origLen - editLen);

  return Math.min(1.0, +(changes / maxLen).toFixed(2));
}
