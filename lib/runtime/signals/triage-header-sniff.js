/**
 * Triage header sniffing — STAQPRO-523
 *
 * Deterministic, pre-LLM classification for vendor / marketing / automated
 * inbound email. Pure function: no DB, no IO, no Date.now() — so it's trivially
 * unit-testable and safe to call from both the live runtime path
 * (`agents/executor-intake/index.js`) and the backfill script
 * (`autobot-inbox/scripts/reclassify-vendor-noise.js`).
 *
 * The goal is cost reduction: roughly half of newsletter/vendor inbound should
 * bypass Haiku entirely. The override clause (inner_circle / active contact)
 * is the only thing standing between this code and silently burying a real
 * reply from a human at sender@support.example.com, so callers MUST pass an
 * accurate `contactTier` whenever the sender has any history.
 *
 * ## Scope note (read before adding rules)
 *
 * The Linear issue specifies rules over `List-Unsubscribe`, `Precedence`, and
 * `Auto-Submitted` headers. The current Gmail poller in
 * `autobot-inbox/src/gmail/client.js` does NOT fetch those headers — only
 * From / To / Cc / Subject / Date / Message-ID / In-Reply-To. The poller would
 * have to be widened (and `inbox.messages` would need a column or jsonb blob
 * for raw headers) before those rules fire on live data.
 *
 * This module accepts a `headers` object on the message for forward-compat:
 * the rules ARE coded, they just no-op on rows where the poller hasn't
 * captured the header. When the poller is widened (separate issue — flagged
 * in the STAQPRO-523 plan), the rules light up automatically. In the meantime
 * the function works on what IS available today: `labels`, `from_address`,
 * `subject`, and `snippet`. Those four cover the high-volume cases (Gmail's
 * own `CATEGORY_PROMOTIONS` tag, generic role-account local-parts, and
 * unsubscribe footers visible in the snippet).
 *
 * @typedef {Object} MessageRow
 * @property {string} [from_address]   Lowercased sender email
 * @property {string} [subject]
 * @property {string} [snippet]        First ~200 chars of body (Gmail-provided)
 * @property {string[]} [labels]       Gmail label IDs
 * @property {Object<string, string>} [headers]  Lowercased header name → value.
 *                                     Optional; rules that need headers no-op
 *                                     when this is missing or empty.
 *
 * @typedef {Object} SniffResult
 * @property {'noise'|'fyi'|'pending'} category
 * @property {string} reason           e.g. 'header_sniff:list_unsubscribe'.
 *                                     Stable, audit-friendly identifier.
 *
 * @param {MessageRow} message
 * @param {{ contactTier?: string | null }} [options]
 * @returns {SniffResult | null}  null means "no rule matched, fall through to LLM"
 */

// Static ESP allowlist. No live DNS in the hot path — the issue calls this out
// explicitly. If we ever want MX-based detection, cache it in
// signal.contacts.metadata via a background job, never the request path.
const KNOWN_ESP_DOMAINS = [
  'sendgrid.net',
  'sendgrid.com',
  'mailgun.org',
  'mailgun.com',
  'mailchimp.com',
  'mcsv.net', // Mailchimp envelope sender
  'sparkpostmail.com',
  'sparkpost.com',
  'postmarkapp.com',
  'pmdeliveries.net',
  'amazonses.com',
  'sesv2.amazonaws.com',
  'customeriomail.com',
  'customer.io',
];

// Role-account local-parts that almost never come from a human at a real
// company. The issue's regex is the source of truth — keep this in sync.
const GENERIC_LOCALPART_RE =
  /^(noreply|no-reply|donotreply|do-not-reply|notifications?|alerts?|billing|receipts?|hello|hey|team|support|hi|info)$/i;

// Anchored unsubscribe footer detector. We don't have full bodies in the hot
// path — only the Gmail snippet (~200 chars). Real unsubscribe links almost
// always live near the bottom of the message and won't appear in the snippet,
// so this rule fires rarely in practice; it's mostly here for the backfill
// path which can pass a richer body if available.
const UNSUBSCRIBE_FOOTER_RE =
  /\bunsubscribe\b[^\n]{0,200}?(http|click here|manage preferences|opt[- ]?out)/i;

// "Real correspondent" override — issue says inner_circle / active.
const TRUSTED_TIERS = new Set(['inner_circle', 'active']);

// ---------------------------------------------------------------------------
// STAQPRO-562 — machine-notification class (structured-field only)
// ---------------------------------------------------------------------------
//
// INVARIANT (non-negotiable): the noise classification below is derived ONLY
// from structured fields — channel, sender domain, event type, and the
// presence/absence of a linked work_item_id. It NEVER inspects body text or
// asks an LLM. That's the entire point: deterministic, $0, un-gameable.
//
// These vendors used to sit in the `fyi` allowlist, which surfaced their
// push/CI/deploy chatter to Telegram/Slack/Board. They are now their own
// `machine_notification` class: noise/archive UNLESS the event is tied to an
// owned work_item (e.g. a PR/issue we're actually driving). When linked, the
// caller keeps the existing dedicated handler (PR-merged → close Linear, etc.);
// when unlinked, it's noise.
const MACHINE_NOTIFICATION_DOMAINS = new Set([
  'github.com',
  'linear.app',
  'vercel.com',
  'railway.app',
]);

// Sender localparts/addresses that are machine notifications regardless of the
// rest of the domain (Google sends calendar notifications from this address on
// google.com, which is otherwise a human domain).
const MACHINE_NOTIFICATION_ADDRESSES = new Set([
  'calendar-notification@google.com',
]);

// GitHub / CI event types that are pure noise when not linked to an owned
// work_item. These mirror the webhook `x-github-event` + check/CI events that
// the strategist was burning gemini-2.5-pro auto-archiving.
const NOISE_EVENT_TYPES = new Set([
  'push',
  'check_run',
  'check_suite',
  'workflow_run',
  'workflow_job',
  'status',
  'deployment',
  'deployment_status',
]);

/**
 * Is this sender a known machine-notification source? Pure domain/address
 * match — no DNS, no body, no LLM.
 *
 * @param {string} senderDomain  Lowercased domain (e.g. 'github.com')
 * @param {string} [fromAddress] Lowercased full address, for the per-address
 *                               overrides (calendar-notification@google.com)
 * @returns {boolean}
 */
function isMachineNotificationSender(senderDomain, fromAddress = '') {
  if (fromAddress && MACHINE_NOTIFICATION_ADDRESSES.has(fromAddress)) return true;
  if (!senderDomain) return false;
  for (const d of MACHINE_NOTIFICATION_DOMAINS) {
    // Exact or subdomain match: github.com matches notifications.github.com.
    if (senderDomain === d || senderDomain.endsWith(`.${d}`)) return true;
  }
  return false;
}

/**
 * STAQPRO-563 — explicit GitHub belt-and-suspenders rule.
 *
 * Dead-simple and self-contained ON PURPOSE: it does not consult the
 * STAQPRO-562 MACHINE_NOTIFICATION_DOMAINS set or classifyMachineNotification.
 * GitHub is the single dominant noise source; this guarantees it is always
 * caught even if the broader vendor/header machinery regresses or is edited.
 *
 * Two structured triggers (no body, no LLM):
 *   1. from_address is exactly notifications@github.com (the address GitHub
 *      sends issue/PR/CI notification mail from), OR
 *   2. the List-ID header contains "github.com" (the mailing-list identity
 *      GitHub stamps on every notification, e.g.
 *      "owner/repo <repo.owner.github.com>").
 *
 * @param {string|undefined|null} fromAddress  Raw From value
 * @param {Object<string,string>} headers       Lowercased header map
 * @returns {SniffResult | null}
 */
export function classifyGithubNoise(fromAddress, headers) {
  const { localpart, domain } = parseAddress(fromAddress);
  const addr = localpart && domain ? `${localpart}@${domain}` : '';

  // Trigger 1: notifications@github.com exactly.
  if (addr === 'notifications@github.com') {
    return { category: 'noise', reason: 'github_noise:notifications_address' };
  }

  // Trigger 2: List-ID header contains github.com.
  const listId = headerValue(headers, 'list-id');
  if (listId && listId.includes('github.com')) {
    return { category: 'noise', reason: 'github_noise:list_id' };
  }

  return null;
}

/**
 * Deterministic machine-notification classifier — the structured-field path
 * used by the signal ingester and the GitHub webhook short-circuit. Mirrors
 * the email `cost_usd: 0` fast-path: returns a verdict BEFORE any model call.
 *
 * INVARIANT: inputs are structured fields only.
 *
 * @param {Object} input
 * @param {string} [input.channel]           e.g. 'github', 'email', 'webhook'
 * @param {string} [input.senderDomain]      Lowercased sender domain
 * @param {string} [input.fromAddress]       Lowercased full sender address
 * @param {string} [input.eventType]         e.g. 'push', 'check_run', 'pull_request'
 * @param {string|number|null} [input.linkedWorkItemId]  Owned work_item, if any
 * @returns {SniffResult | null}  noise verdict, or null to fall through
 */
export function classifyMachineNotification(input = {}) {
  if (!input || typeof input !== 'object') return null;

  const channel = String(input.channel || '').toLowerCase();
  const senderDomain = String(input.senderDomain || '').toLowerCase();
  const fromAddress = String(input.fromAddress || '').toLowerCase();
  const eventType = String(input.eventType || '').toLowerCase();
  const linked = input.linkedWorkItemId != null && input.linkedWorkItemId !== '';

  // A linked, owned work_item is never noise — it has a real handler. Bail so
  // the caller keeps its dedicated path (PR-merged → close Linear, etc.).
  if (linked) return null;

  // Rule A: github channel + a known-noise event type → noise. This is the
  // channel+event-type pre-promotion gate (unlinked CI/push/etc.).
  if (channel === 'github' && NOISE_EVENT_TYPES.has(eventType)) {
    return { category: 'noise', reason: `machine_notification:github_${eventType}` };
  }

  // Rule B: sender is a known machine-notification vendor (by domain or the
  // calendar-notification@ override) → noise. Covers the email side where the
  // vendor mails us push/deploy/calendar chatter.
  if (isMachineNotificationSender(senderDomain, fromAddress)) {
    const label = senderDomain || fromAddress || 'vendor';
    return { category: 'noise', reason: `machine_notification:${label}` };
  }

  // Rule C: any github-channel event with no linked work_item and no specific
  // handler is still machine noise — never promote it to a human surface.
  if (channel === 'github') {
    return { category: 'noise', reason: `machine_notification:github_unlinked${eventType ? `_${eventType}` : ''}` };
  }

  return null;
}

/**
 * @param {string | undefined | null} fromAddress
 * @returns {{ localpart: string, domain: string }}
 */
function parseAddress(fromAddress) {
  if (!fromAddress || typeof fromAddress !== 'string') {
    return { localpart: '', domain: '' };
  }
  // Strip RFC 5322 angle brackets and surrounding whitespace.
  // Return-Path / Sender headers commonly look like `<bounce@bounces.sendgrid.net>`.
  // We also strip any trailing display-name fragments by taking only the
  // last <...> pair if present; otherwise fall back to a naive trim.
  let cleaned = fromAddress.trim();
  const lt = cleaned.lastIndexOf('<');
  const gt = cleaned.lastIndexOf('>');
  if (lt >= 0 && gt > lt) {
    cleaned = cleaned.slice(lt + 1, gt).trim();
  }
  const at = cleaned.lastIndexOf('@');
  if (at < 0) return { localpart: cleaned.toLowerCase(), domain: '' };
  return {
    localpart: cleaned.slice(0, at).toLowerCase(),
    domain: cleaned.slice(at + 1).toLowerCase(),
  };
}

/**
 * Normalize a value returned by a callers' `headers` map. Header values are
 * sometimes arrays (when there are multiple instances of the same header);
 * we just want a single lowercase string for matching.
 *
 * @param {unknown} value
 * @returns {string}
 */
function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  // Accept both lowercased and original-case keys defensively.
  const raw = headers[name] ?? headers[name.toLowerCase()] ?? '';
  if (Array.isArray(raw)) return String(raw[0] ?? '').toLowerCase();
  return String(raw ?? '').toLowerCase();
}

/**
 * @param {MessageRow} message
 * @param {{ contactTier?: string | null }} [options]
 * @returns {SniffResult | null}
 */
export function classifyByHeaders(message, options = {}) {
  if (!message || typeof message !== 'object') return null;

  // Override clause — MUST run before any rule. A human at a real company is
  // allowed to email from hello@ / support@ / hi@ etc. Silently burying their
  // reply because of a regex on the localpart is the worst-case failure mode.
  const contactTier = options.contactTier ?? null;
  if (contactTier && TRUSTED_TIERS.has(contactTier)) {
    return null;
  }

  const headers = message.headers || {};
  const { localpart, domain } = parseAddress(message.from_address);
  const labels = Array.isArray(message.labels) ? message.labels : [];

  // ---- Rule 0a: Explicit GitHub belt-and-suspenders (STAQPRO-563) -------
  // The single dominant noise source. This is DELIBERATELY independent of the
  // STAQPRO-562 vendor table below: a dead-simple, self-contained rule that
  // catches GitHub notification mail even if 562's broader header/vendor work
  // regresses. Structured fields only (from_address + List-ID header) — no
  // body, no LLM. Belt-and-suspenders: if Rule 0b changes shape, this stays.
  const githubNoise = classifyGithubNoise(message.from_address, headers);
  if (githubNoise) return githubNoise;

  // ---- Rule 0b: Machine-notification vendor → noise (STAQPRO-562) --------
  // github.com / linear.app / vercel.com / railway.app /
  // calendar-notification@google.com used to land in `fyi` (via Rule 5 ESP or
  // Rule 4 generic-localpart). They are now their own noise class: structured
  // sender-domain match only, no body. This runs before the fyi rules so the
  // vendor chatter never reaches a human surface. The trusted-tier override
  // above still wins, so a human at one of these orgs emailing us directly
  // (tier=active/inner_circle) is unaffected.
  const fullFrom = localpart && domain ? `${localpart}@${domain}` : '';
  const machine = classifyMachineNotification({
    channel: 'email',
    senderDomain: domain,
    fromAddress: fullFrom,
  });
  if (machine) return machine;

  // ---- Rule 1: List-Unsubscribe present → noise -------------------------
  // RFC 2369 / 8058. Marketing senders and mailing lists almost universally
  // ship this header; legitimate one-to-one mail does not.
  if (headerValue(headers, 'list-unsubscribe')) {
    return { category: 'noise', reason: 'header_sniff:list_unsubscribe' };
  }

  // ---- Rule 2: Precedence: bulk | list → noise --------------------------
  const precedence = headerValue(headers, 'precedence');
  if (precedence === 'bulk' || precedence === 'list' || precedence === 'junk') {
    return { category: 'noise', reason: `header_sniff:precedence_${precedence}` };
  }

  // ---- Rule 3: Auto-Submitted not "no" → noise --------------------------
  // RFC 3834. Bounces, vacation replies, and bot-generated mail set this.
  const autoSubmitted = headerValue(headers, 'auto-submitted');
  if (autoSubmitted && autoSubmitted !== 'no') {
    return { category: 'noise', reason: 'header_sniff:auto_submitted' };
  }

  // ---- Rule 4: Generic role-account localpart → fyi ---------------------
  // No "prior reply history" check yet — we approximate "no history" via the
  // contactTier gate above. A contact that's seen exchanges with us will be
  // tier=active/inner_circle and bypass this entirely.
  if (localpart && GENERIC_LOCALPART_RE.test(localpart)) {
    return { category: 'fyi', reason: `header_sniff:generic_localpart_${localpart}` };
  }

  // ---- Rule 5: Sender on a known ESP → fyi ------------------------------
  // We check the `From:` domain AND any envelope-sender hints the poller
  // stored (Return-Path / X-Sender). This matches the spirit of "MX hosted on
  // an ESP" without making live DNS calls — issue requires static allowlist.
  const returnPathDomain = parseAddress(headerValue(headers, 'return-path')).domain;
  const senderDomain = parseAddress(headerValue(headers, 'sender')).domain;
  for (const espDomain of KNOWN_ESP_DOMAINS) {
    if (
      (domain && domain.endsWith(espDomain)) ||
      (returnPathDomain && returnPathDomain.endsWith(espDomain)) ||
      (senderDomain && senderDomain.endsWith(espDomain))
    ) {
      return { category: 'fyi', reason: `header_sniff:esp_${espDomain}` };
    }
  }

  // ---- Rule 6: Unsubscribe link in body footer → downgrade only ---------
  // This rule doesn't classify, it suggests a downgrade. The issue spells it
  // out: action_required → fyi, needs_response → pending. We return a
  // SniffResult only when the downgrade has somewhere to land — i.e. the
  // caller hasn't otherwise resolved the message. Use a category of 'fyi'
  // here so that the no-LLM path lands the message in the "informational"
  // bucket rather than the actionable queue. The full conditional downgrade
  // logic lives in the caller (executor-intake), which knows the LLM's
  // prospective answer; in the standalone hot-path we just emit a deterministic
  // fyi which is strictly safer than action_required.
  const snippet = (message.snippet || '').toLowerCase();
  if (UNSUBSCRIBE_FOOTER_RE.test(snippet)) {
    return { category: 'fyi', reason: 'header_sniff:unsubscribe_footer' };
  }

  // ---- Rule 7: Gmail CATEGORY_PROMOTIONS / CATEGORY_FORUMS --------------
  // Already handled in executor-intake's existing label fast-path, but
  // reapplying here makes the sniffer self-contained for the backfill script
  // and for any caller that bypasses the existing fast-paths. Idempotent: if
  // the existing fast-path already classified, executor-intake won't reach
  // this code in the first place.
  if (labels.includes('CATEGORY_PROMOTIONS') || labels.includes('CATEGORY_FORUMS')) {
    return { category: 'noise', reason: 'header_sniff:gmail_promotions' };
  }

  return null;
}

export const __test__ = {
  KNOWN_ESP_DOMAINS,
  GENERIC_LOCALPART_RE,
  TRUSTED_TIERS,
  MACHINE_NOTIFICATION_DOMAINS,
  MACHINE_NOTIFICATION_ADDRESSES,
  NOISE_EVENT_TYPES,
  isMachineNotificationSender,
  classifyGithubNoise,
};
