/**
 * PII redaction for log output (spec §5: data classification).
 * Redacts email addresses and truncates subjects in non-CLI log output.
 * CLI output is exempt (board needs to see content to review).
 */

/**
 * Redact an email address for logging: "user@domain.com" → "u***@domain.com"
 */
export function redactEmail(email) {
  if (!email || typeof email !== 'string') return '(unknown)';
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return `${local[0]}***@${domain}`;
}

/**
 * Truncate a subject for logging.
 */
export function truncateSubject(subject, maxLen = 30) {
  if (!subject) return '(no subject)';
  return subject.length > maxLen ? subject.slice(0, maxLen) + '...' : subject;
}

/**
 * Redact secrets/tokens from log output (P2: infrastructure enforces).
 * Applied surgically at known leak points (spawn-cli stderr, git clone errors).
 */
const SECRET_PATTERNS = [
  // GitHub PATs (ghp_ classic, ghs_ app installation, ghu_ user-to-server, fine-grained)
  [/ghp_[A-Za-z0-9]{20,}/g, '[REDACTED:ghp]'],
  [/ghs_[A-Za-z0-9]{20,}/g, '[REDACTED:ghs]'],
  [/ghu_[A-Za-z0-9]{20,}/g, '[REDACTED:ghu]'],
  [/github_pat_[A-Za-z0-9_]{22,}/g, '[REDACTED:github_pat]'],
  // GitHub App installation tokens (v1.hex)
  [/v1\.[a-f0-9]{40}/g, '[REDACTED:v1]'],
  // x-access-token in git clone URLs — the critical leak vector
  [/x-access-token:[^@\s]+@/g, 'x-access-token:[REDACTED]@'],
  // Bearer tokens in HTTP error messages
  [/Bearer\s+[A-Za-z0-9_\-\.]{20,}/g, 'Bearer [REDACTED]'],
  // JWT tokens (header.payload.signature)
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED:JWT]'],
];

export function redactSecrets(str) {
  if (!str || typeof str !== 'string') return str || '';
  let result = str;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
