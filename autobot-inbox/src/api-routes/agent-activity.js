/**
 * GET /api/agent-activity — SSE stream for agent state-transition events.
 *
 * Dedicated observability stream that filters the event bus to
 * state_changed and task_assigned events, so board clients can subscribe
 * to a focused feed without receiving all SSE payload types from /api/events.
 *
 * Clients receive:
 *   event: state_changed | task_assigned
 *   data: { work_item_id, agent_id, from_state, to_state, reason,
 *            cost_usd, guardrail_checks_json, title, item_type, … }
 *
 * Also emits a keepalive comment every 25s to prevent proxy timeouts.
 */

const RELAY_EVENTS = new Set(['state_changed', 'task_assigned', 'task_completed', 'task_failed']);

export function registerAgentActivitySSERoute(routes, getCorsHeaders) {
  routes.set('GET /api/agent-activity', async (req, _body, res) => {
    res.writeHead(200, {
      ...getCorsHeaders(req),
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // disable nginx buffering
    });

    // Initial connection confirmation
    res.write(':ok\n\n');

    let cleanup = null;

    try {
      const { onAnyEvent } = await import('../runtime/infrastructure.js');

      cleanup = onAnyEvent((event) => {
        try {
          const eventType = event.eventType || event.event_type || 'unknown';
          if (!RELAY_EVENTS.has(eventType)) return;
          res.write(`event: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`);
        } catch {
          // Client disconnected — cleanup will fire via 'close'
        }
      });
    } catch {
      // Event bus unavailable (e.g. test env) — stream stays open, only keepalives sent
    }

    // Keepalive comment every 25s
    const keepalive = setInterval(() => {
      try {
        res.write(': keepalive\n\n');
      } catch {
        clearInterval(keepalive);
      }
    }, 25_000);

    req.on('close', () => {
      clearInterval(keepalive);
      if (cleanup) cleanup();
    });

    return '__sse__'; // signal to the api.js dispatcher to skip JSON response
  });
}
