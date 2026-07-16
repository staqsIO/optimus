/**
 * Pure-function detector: Linear webhook payload → "Ready for Optimus" signal.
 *
 * PRD: autobot-inbox/docs/internal/prds/meeting-actions-to-kanban-v0.2-tech-spec.md
 *      FR-15.
 *
 * Contract:
 *   detectReadyForOptimus({ payload, mapping, optimusHandle='optimus' })
 *     → { ready, source, comment_text?, actor }
 *
 * Two equivalent triggers:
 *   - State path: Issue event whose stateId === mapping.awaitingOptimusStateId
 *     → { ready:true, source:'state', actor }.
 *   - Comment path: Comment event whose body contains `@<optimusHandle>` with
 *     a word boundary (not preceded by another word char or `@`, not followed
 *     by another word char or `.`) → { ready:true, source:'comment',
 *     comment_text, actor }.
 *
 * Default → { ready:false, source:null }.
 *
 * Pure: no I/O, no DB, no Linear API. Defensive against null / undefined /
 * empty payloads (never throws).
 *
 * @param {{
 *   payload?: object|null,
 *   mapping?: Record<string, unknown>|null,
 *   optimusHandle?: string,
 * }} [args]
 * @returns {{ ready: boolean, source: ('state'|'comment'|null), comment_text?: string, actor?: string }}
 */
export function detectReadyForOptimus({ payload, mapping, optimusHandle = 'optimus' } = {}) {
  const miss = { ready: false, source: null };

  if (!payload || typeof payload !== 'object') return miss;
  const { type, data, actor } = payload;
  if (!data || typeof data !== 'object') return miss;

  const safeMapping = (mapping && typeof mapping === 'object') ? mapping : {};

  // ---- State path ---------------------------------------------------------
  if (type === 'Issue') {
    const awaitingId = safeMapping.awaitingOptimusStateId;
    const stateId = (data.state && typeof data.state === 'object' ? data.state.id : null)
      ?? data.stateId
      ?? null;
    if (awaitingId && stateId && stateId === awaitingId) {
      const actorName = (data.assignee && data.assignee.name)
        || (actor && actor.name)
        || 'unknown';
      return { ready: true, source: 'state', actor: actorName };
    }
    return miss;
  }

  // ---- Comment path -------------------------------------------------------
  if (type === 'Comment') {
    const body = typeof data.body === 'string' ? data.body : '';
    if (!body) return miss;
    const handle = String(optimusHandle || 'optimus').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Word-boundary mention:
    //   - preceded by start-of-string or any non-word, non-`@` character
    //   - the literal `@<handle>`
    //   - not followed by another word char or `.` (rules out emails and longer handles)
    const re = new RegExp(`(^|[^\\w@])@${handle}(?![\\w.])`, 'i');
    if (re.test(body)) {
      const actorName = (data.user && data.user.name)
        || (actor && actor.name)
        || 'unknown';
      return {
        ready: true,
        source: 'comment',
        comment_text: body,
        actor: actorName,
      };
    }
    return miss;
  }

  return miss;
}
