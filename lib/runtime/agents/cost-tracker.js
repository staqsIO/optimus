/**
 * Session Cost Tracker (Claude Code Architecture Audit — Change 8).
 *
 * Tracks cumulative cost per agent session (multi-turn execution).
 * Persists incrementally so cost is not lost on crash.
 *
 * Inspired by Claude Code's cost-tracker.js which tracks cost at the
 * session level with real-time visibility.
 */

import { query } from '../../db.js';

export class SessionCostTracker {
  constructor(agentId, sessionStepId = null) {
    this.agentId = agentId;
    this.sessionStepId = sessionStepId;
    this.totalCostUsd = 0;
    this.callCount = 0;
    this._lastPersistAt = 0;
  }

  /**
   * Record a cost increment. Persists to DB every 5 calls or 30s.
   */
  async add(costUsd) {
    this.totalCostUsd += costUsd;
    this.callCount += 1;

    // Throttled persistence
    if (this.sessionStepId && (this.callCount % 5 === 0 || Date.now() - this._lastPersistAt > 30_000)) {
      this._lastPersistAt = Date.now();
      query(
        `UPDATE agent_graph.agent_activity_steps
         SET metadata = metadata || $1
         WHERE id = $2`,
        [JSON.stringify({ session_cost_usd: this.totalCostUsd, session_call_count: this.callCount }), this.sessionStepId]
      ).catch(() => {}); // non-critical
    }
  }

  /** Check if session is within budget. */
  checkBudget(maxUsd) {
    return this.totalCostUsd <= maxUsd;
  }

  /** Get current totals. */
  totals() {
    return { costUsd: this.totalCostUsd, calls: this.callCount };
  }
}
