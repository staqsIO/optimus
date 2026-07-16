/**
 * Runtime error types. Carry semantic codes so callers can route on the cause
 * (instanceof check) instead of parsing message strings.
 */

/**
 * Thrown by context-loader when G8 (Model Armor) is in block mode and detects
 * a HIGH-confidence prompt-injection match in fetched content. Caught by
 * agent-loop, which transitions the work item to 'cancelled' (not 'failed' —
 * quarantine is a deliberate decision, not a transient fault).
 */
export class G8QuarantineError extends Error {
  constructor(reason, detail = {}) {
    super(reason);
    this.name = 'G8QuarantineError';
    this.code = 'G8_QUARANTINE';
    this.detail = detail;
  }
}
