/**
 * Campaign Scorer (ADR-021) — Constraint-Based Evaluation
 *
 * Replaced self-assessment (LLM reports own quality) with heuristic constraint checking:
 * 1. Word count in expected range for task type
 * 2. Required structural elements present
 * 3. No prohibited patterns (self-assessment, execution reports)
 * 4. Format compliance (deliverable matches requested format)
 * 5. Output envelope detection
 */

export const FAILURE_REASONS = {
  NO_CODE_BLOCKS: 'no_code_blocks',
  CODE_TOO_SHORT: 'code_too_short',
  PLACEHOLDER_STUBS: 'placeholder_stubs',
  SELF_ASSESSMENT: 'self_assessment',
  ENVELOPE_WRAPPED: 'envelope_wrapped',
  MISSING_SECTIONS: 'missing_sections',
  WORD_COUNT_LOW: 'word_count_low',
};

/**
 * Constraint-based quality evaluation.
 * Checks structural quality of output rather than trusting LLM self-scores.
 *
 * @param {string} output - The raw LLM output text
 * @param {Array} successCriteria - Board-defined criteria (used for format expectations)
 * @param {Object} [options] - Additional evaluation options
 * @param {string} [options.expectedFormat] - 'html', 'json', 'sql', 'markdown', 'text'
 * @param {number} [options.minWords] - Minimum word count
 * @param {number} [options.maxWords] - Maximum word count
 * @returns {{score: number, passed: boolean, details: Object}}
 */
export function evaluateSuccessCriteria(output, successCriteria, options = {}) {
  if (!output || typeof output !== 'string') {
    return { score: 0, passed: false, details: { error: 'No output to evaluate' } };
  }

  const checks = {};
  const failureReasons = [];
  let totalPoints = 0;
  let earnedPoints = 0;

  // --- Check 1: Word count ---
  const words = output.split(/\s+/).filter(w => w.length > 0);
  const wordCount = words.length;
  const minWords = options.minWords || 20;
  const maxWords = options.maxWords || 50000;
  const wordCountOk = wordCount >= minWords && wordCount <= maxWords;
  checks.word_count = { met: wordCountOk, actual: wordCount, min: minWords, max: maxWords };
  totalPoints += 1;
  if (wordCountOk) earnedPoints += 1;
  else failureReasons.push(FAILURE_REASONS.WORD_COUNT_LOW);

  // --- Check 2: No self-assessment artifacts ---
  const selfAssessmentPatterns = [
    /quality\s*score\s*[:=]\s*\d/i,
    /estimated\s*accuracy\s*[:=]\s*\d/i,
    /confidence\s*[:=]\s*\d/i,
    /self[_-]?assessment/i,
    /execution\s*report/i,
    /task\s*completion\s*summary/i,
    /##?\s*quality\s*(assessment|evaluation|score)/i,
  ];
  const selfAssessmentFound = selfAssessmentPatterns.filter(p => p.test(output));
  checks.no_self_assessment = { met: selfAssessmentFound.length === 0, violations: selfAssessmentFound.map(p => p.source) };
  totalPoints += 2; // weighted higher — this is the core fix
  if (selfAssessmentFound.length === 0) earnedPoints += 2;
  else failureReasons.push(FAILURE_REASONS.SELF_ASSESSMENT);

  // --- Check 3: Format compliance ---
  const expectedFormat = options.expectedFormat || detectExpectedFormat(successCriteria);
  if (expectedFormat) {
    const formatOk = checkFormatCompliance(output, expectedFormat);
    checks.format_compliance = { met: formatOk, expectedFormat };
    totalPoints += 2;
    if (formatOk) earnedPoints += 2;
  }

  // --- Check 4: No execution report envelope ---
  // If fenced code block exists and surrounding narrative > 2x code length, it's wrapped
  const envelopeCheck = checkOutputEnvelope(output);
  checks.no_envelope = { met: !envelopeCheck.isWrapped, ...envelopeCheck };
  totalPoints += 1;
  if (!envelopeCheck.isWrapped) earnedPoints += 1;
  else failureReasons.push(FAILURE_REASONS.ENVELOPE_WRAPPED);

  // --- Check 5: Required sections (from success criteria) ---
  const requiredSections = extractRequiredSections(successCriteria);
  if (requiredSections.length > 0) {
    const found = requiredSections.filter(s => output.toLowerCase().includes(s.toLowerCase()));
    const sectionsPassed = found.length >= requiredSections.length * 0.5; // 50% threshold
    checks.required_sections = { met: sectionsPassed, required: requiredSections, found: found.length, total: requiredSections.length };
    totalPoints += 1;
    if (sectionsPassed) earnedPoints += 1;
    else failureReasons.push(FAILURE_REASONS.MISSING_SECTIONS);
  }

  const score = totalPoints > 0 ? Math.round((earnedPoints / totalPoints) * 10000) / 10000 : 0;
  const passed = score >= 0.7; // 70% threshold for passing

  return { score, passed, details: checks, raw: { quality_score: score }, failureReasons };
}

/**
 * Stateful/project campaign scorer: evaluates workspace changes + CLI output.
 *
 * Scoring strategy (in order of preference):
 * 1. Git diff --stat (committed changes) — most reliable signal
 * 2. Git status --porcelain (uncommitted changes) — CLI wrote files but didn't commit
 * 3. CLI output text length + quality signals — fallback when no git changes detected
 *
 * @param {string} diffText - git diff --stat output from getCumulativeDiff()
 * @param {string} executeText - CLI output text
 * @param {string} [statusText] - git status --porcelain output (uncommitted changes)
 * @returns {{score: number, passed: boolean, details: Object, failureReasons: string[]}}
 */
export function evaluateStatefulOutput(diffText, executeText, statusText) {
  const failureReasons = [];
  const cliText = executeText || '';
  const hasError = /error|failed|exception|crash/i.test(cliText) && !/fixed|resolved|handled/i.test(cliText);

  // --- Strategy 1: Committed diff (best signal) ---
  if (diffText && diffText.trim().length >= 20) {
    const insertions = parseInt((diffText.match(/(\d+) insertions?/)?.[1]) || '0');
    const deletions = parseInt((diffText.match(/(\d+) deletions?/)?.[1]) || '0');
    const filesChanged = parseInt((diffText.match(/(\d+) files? changed/)?.[1]) || '0');
    const totalChanges = insertions + deletions;

    // Generous scoring: any committed changes with no errors should pass
    let score = 0.3; // Base for having committed work
    if (totalChanges > 5) score += 0.25;    // Even small changes count
    if (totalChanges > 50) score += 0.1;
    if (totalChanges > 200) score += 0.05;
    if (filesChanged > 0 && filesChanged <= 20) score += 0.1;
    if (!hasError) score += 0.2;
    else failureReasons.push('cli_errors_detected');

    score = Math.min(score, 1.0);
    return {
      score: Math.round(score * 10000) / 10000,
      passed: score >= 0.5,
      details: { source: 'committed_diff', filesChanged, insertions, deletions, totalChanges, hasError },
      failureReasons,
    };
  }

  // --- Strategy 2: Uncommitted changes (CLI wrote files but didn't commit) ---
  if (statusText && statusText.trim().length > 0) {
    const changedFiles = statusText.trim().split('\n').filter(l => l.trim().length > 0);
    const fileCount = changedFiles.length;

    let score = 0.35; // Base for having uncommitted work
    if (fileCount > 0) score += 0.25;
    if (fileCount > 3) score += 0.1;
    if (!hasError) score += 0.2;
    else failureReasons.push('cli_errors_detected');

    score = Math.min(score, 1.0);
    return {
      score: Math.round(score * 10000) / 10000,
      passed: score >= 0.5,
      details: { source: 'uncommitted_status', fileCount, files: changedFiles.slice(0, 10), hasError },
      failureReasons,
    };
  }

  // --- Strategy 3: CLI output quality (no git changes at all — score the text) ---
  // This handles cases where the agent reports completing work but didn't write to the worktree
  const wordCount = cliText.split(/\s+/).filter(w => w.length > 0).length;
  if (wordCount > 50 && !hasError) {
    // Substantial non-error output — agent probably did useful work
    let score = 0.3;
    if (wordCount > 100) score += 0.15;
    if (wordCount > 300) score += 0.15;
    if (/written|created|generated|completed|produced|saved/i.test(cliText)) score += 0.2;
    if (!hasError) score += 0.2;

    score = Math.min(score, 1.0);
    return {
      score: Math.round(score * 10000) / 10000,
      passed: score >= 0.5,
      details: { source: 'cli_text_fallback', wordCount, hasError },
      failureReasons: hasError ? ['cli_errors_detected'] : [],
    };
  }

  // Nothing useful found
  return { score: 0.1, passed: false, details: { source: 'no_signal', reason: 'No git changes and no substantial CLI output' }, failureReasons: ['no_changes'] };
}

/**
 * Build-mode scorer: evaluates code blocks extracted from narrative output.
 * Build campaigns produce text-only output (tools disabled), so code is embedded
 * in fenced blocks. This scorer extracts and evaluates the code directly,
 * skipping self-assessment and envelope checks that penalize narrative wrapping.
 *
 * @param {string} output - Raw LLM text output
 * @param {Array} successCriteria - Board-defined criteria
 * @param {Object} [options] - Evaluation options
 * @returns {{score: number, passed: boolean, details: Object}}
 */
export function evaluateBuildOutput(output, successCriteria, options = {}) {
  if (!output || typeof output !== 'string') {
    return { score: 0, passed: false, details: { error: 'No output to evaluate' } };
  }

  const checks = {};
  const failureReasons = [];
  let totalPoints = 0;
  let earnedPoints = 0;

  // --- Extract all fenced code blocks ---
  const codeBlocks = [];
  for (const match of output.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    const block = match[1].trim();
    if (block.length > 10) codeBlocks.push(block); // Skip trivial blocks
  }
  const totalCodeLength = codeBlocks.reduce((sum, b) => sum + b.length, 0);

  // --- Check 1: Has code blocks ---
  const hasCode = codeBlocks.length >= 1;
  checks.has_code_blocks = { met: hasCode, count: codeBlocks.length, totalChars: totalCodeLength };
  totalPoints += 2;
  if (hasCode) earnedPoints += 2;
  else failureReasons.push(FAILURE_REASONS.NO_CODE_BLOCKS);

  // --- Check 2: Code volume (meaningful amount of code) ---
  const minCodeChars = options.minCodeChars || 100;
  const volumeOk = totalCodeLength >= minCodeChars;
  checks.code_volume = { met: volumeOk, actual: totalCodeLength, min: minCodeChars };
  totalPoints += 2;
  if (volumeOk) earnedPoints += 2;
  else failureReasons.push(FAILURE_REASONS.CODE_TOO_SHORT);

  // --- Check 3: No placeholder stubs ---
  const allCode = codeBlocks.join('\n');
  const stubPatterns = [
    /\/\/\s*TODO/gi,
    /\/\/\s*\.\.\./g,
    /\/\*\s*\.\.\.\s*\*\//g,
    /pass\s*#\s*TODO/gi,
    /raise\s+NotImplementedError/g,
    /placeholder/gi,
  ];
  const stubCount = stubPatterns.reduce((count, p) => count + (allCode.match(p) || []).length, 0);
  const stubRatio = stubCount / Math.max(codeBlocks.length, 1);
  const noStubs = stubRatio < 2; // Allow some TODOs, penalize excessive
  checks.no_placeholder_stubs = { met: noStubs, stubCount, stubRatio: Math.round(stubRatio * 100) / 100 };
  totalPoints += 1;
  if (noStubs) earnedPoints += 1;
  else failureReasons.push(FAILURE_REASONS.PLACEHOLDER_STUBS);

  // --- Check 4: Word count (overall output has substance) ---
  const words = output.split(/\s+/).filter(w => w.length > 0);
  const wordCount = words.length;
  const minWords = options.minWords || 50;
  const wordCountOk = wordCount >= minWords;
  checks.word_count = { met: wordCountOk, actual: wordCount, min: minWords };
  totalPoints += 1;
  if (wordCountOk) earnedPoints += 1;
  else failureReasons.push(FAILURE_REASONS.WORD_COUNT_LOW);

  // --- Check 5: Required sections (from success criteria) ---
  const requiredSections = extractRequiredSections(successCriteria);
  if (requiredSections.length > 0) {
    const found = requiredSections.filter(s => output.toLowerCase().includes(s.toLowerCase()));
    const sectionsPassed = found.length >= requiredSections.length * 0.5;
    checks.required_sections = { met: sectionsPassed, required: requiredSections, found: found.length, total: requiredSections.length };
    totalPoints += 1;
    if (sectionsPassed) earnedPoints += 1;
    else failureReasons.push(FAILURE_REASONS.MISSING_SECTIONS);
  }

  const score = totalPoints > 0 ? Math.round((earnedPoints / totalPoints) * 10000) / 10000 : 0;
  const passed = score >= 0.7;

  return { score, passed, details: checks, raw: { quality_score: score }, failureReasons };
}

/**
 * Evaluate content against campaign content policy.
 *
 * @param {string} content - The produced content/artifact
 * @param {Object} contentPolicy - Board-defined policy
 *   Format: {"no_pii": true, "prohibited_content": [...], "require_review_before_deploy": true}
 * @returns {{compliant: boolean, violations: string[]}}
 */
export function evaluateContentPolicy(content, contentPolicy) {
  if (!contentPolicy || Object.keys(contentPolicy).length === 0) {
    return { compliant: true, violations: [] };
  }

  const violations = [];

  // PII check
  if (contentPolicy.no_pii && content) {
    const piiPatterns = [
      /\b\d{3}-\d{2}-\d{4}\b/, // SSN
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/, // email
      /\b\d{16}\b/, // credit card (basic)
      /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/, // phone
    ];
    for (const pattern of piiPatterns) {
      if (pattern.test(content)) {
        violations.push(`PII detected: matches ${pattern.source}`);
      }
    }
  }

  // Prohibited content
  if (contentPolicy.prohibited_content && content) {
    for (const prohibited of contentPolicy.prohibited_content) {
      if (content.toLowerCase().includes(prohibited.toLowerCase())) {
        violations.push(`Prohibited content: "${prohibited}"`);
      }
    }
  }

  return {
    compliant: violations.length === 0,
    violations,
  };
}

/**
 * Check if a URL is reachable (HTTP 2xx response).
 * Used as a success criterion for project campaigns with preview URLs.
 * @param {string} url - URL to check
 * @param {number} [timeoutMs=10000] - Timeout in ms
 * @returns {Promise<{reachable: boolean, statusCode: number|null, error: string|null}>}
 */
export async function checkUrlReachable(url, timeoutMs = 10000) {
  if (!url) return { reachable: false, statusCode: null, error: 'No URL provided' };
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
    return { reachable: res.ok, statusCode: res.status, error: res.ok ? null : `HTTP ${res.status}` };
  } catch (err) {
    return { reachable: false, statusCode: null, error: err.message };
  }
}

/**
 * Detect expected format from success criteria.
 */
function detectExpectedFormat(criteria) {
  if (!criteria || !Array.isArray(criteria)) return null;
  for (const c of criteria) {
    const metric = (c.metric || '').toLowerCase();
    if (metric.includes('html')) return 'html';
    if (metric.includes('json')) return 'json';
    if (metric.includes('sql')) return 'sql';
    if (metric.includes('markdown') || metric.includes('md')) return 'markdown';
  }
  return null;
}

/**
 * Check if output matches expected format.
 */
function checkFormatCompliance(output, format) {
  switch (format) {
    case 'html':
      return /<html[\s>]/i.test(output) || /<body[\s>]/i.test(output) || /<div[\s>]/i.test(output);
    case 'json':
      try { JSON.parse(output.trim()); return true; } catch {
        // Check if there's a JSON block in fenced code
        return /```json[\s\S]*?```/.test(output);
      }
    case 'sql':
      return /\b(SELECT|CREATE|INSERT|ALTER|UPDATE)\b/i.test(output);
    case 'markdown':
      return /^#/m.test(output) || /\*\*/m.test(output);
    default:
      return true;
  }
}

/**
 * Detect if output is wrapped in an execution report envelope.
 */
function checkOutputEnvelope(output) {
  const codeBlocks = [...output.matchAll(/```[^\n]*\n([\s\S]*?)```/g)];
  if (codeBlocks.length === 0) return { isWrapped: false };

  const codeLength = codeBlocks.reduce((sum, m) => sum + m[1].length, 0);
  const totalLength = output.length;
  const narrativeLength = totalLength - codeLength;

  // If narrative is > 3x the code, the output is wrapped (relaxed from 2x)
  const isWrapped = narrativeLength > codeLength * 3 && codeLength > 50;
  return { isWrapped, codeLength, narrativeLength, ratio: narrativeLength / Math.max(codeLength, 1) };
}

/**
 * Extract required section names from success criteria.
 */
function extractRequiredSections(criteria) {
  if (!criteria || !Array.isArray(criteria)) return [];
  const sections = [];
  for (const c of criteria) {
    if (c.required_sections) {
      sections.push(...c.required_sections);
    }
  }
  return sections;
}
