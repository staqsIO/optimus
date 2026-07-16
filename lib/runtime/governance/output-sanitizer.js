/**
 * Output sanitization: strip diligence theater from executor output (spec §4, post-check).
 * P2: Infrastructure enforces — executors don't self-police their output format.
 * P3: Transparency by structure — stripped content is logged, not discarded.
 *
 * Complements the input sanitizer (sanitizer.js) which guards against injection.
 * This module guards against output bloat: execution reports, self-assessment
 * scores, step narration, and tool call logs that executors add around actual work.
 *
 * Patterns loaded from config/output-patterns.json (versioned, not hardcoded).
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createLogger } from '../../logger.js';
const log = createLogger('runtime/output-sanitizer');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================
// Pattern loading
// ============================================================

let compiledPatterns = null; // { category: string, regex: RegExp, description: string }[]
let patternVersion = null;

/**
 * Load and compile patterns from config/output-patterns.json.
 * Lazy-loaded on first call, cached thereafter.
 */
function loadPatterns() {
  if (compiledPatterns) return compiledPatterns;

  try {
    const configPath = join(__dirname, '../../../config/output-patterns.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    patternVersion = config.version || 'unknown';

    compiledPatterns = [];
    for (const [category, def] of Object.entries(config.categories || {})) {
      for (const pat of def.patterns || []) {
        try {
          compiledPatterns.push({
            category,
            regex: new RegExp(pat.regex, pat.flags || 'i'),
            description: pat.description || pat.regex,
          });
        } catch (err) {
          log.warn(`Invalid pattern in ${category}: ${err.message}`);
        }
      }
    }

    log.info(`Loaded ${compiledPatterns.length} patterns (v${patternVersion})`);
  } catch (err) {
    log.warn(`Failed to load patterns: ${err.message}`);
    compiledPatterns = [];
    patternVersion = 'error';
  }

  return compiledPatterns;
}

// ============================================================
// Public API
// ============================================================

/**
 * Sanitize executor output by stripping diligence theater patterns.
 * Returns the sanitized output and metadata about what was stripped.
 *
 * @param {string} output - The raw executor output
 * @param {string} [taskType] - Optional task type for context-aware sanitization
 * @returns {{ sanitized: string, strippedContent: string[], patterns: string[], version: string }}
 */
export function sanitizeOutput(output, taskType) {
  if (!output || typeof output !== 'string') {
    return { sanitized: output, strippedContent: [], patterns: [], version: patternVersion || 'n/a' };
  }

  const patterns = loadPatterns();
  const strippedContent = [];
  const matchedPatterns = [];

  // Process line-by-line for line-anchored patterns
  const lines = output.split('\n');
  const cleanLines = [];

  for (const line of lines) {
    let stripped = false;

    for (const pat of patterns) {
      pat.regex.lastIndex = 0;
      if (pat.regex.test(line)) {
        strippedContent.push(line.trim());
        if (!matchedPatterns.includes(pat.description)) {
          matchedPatterns.push(pat.description);
        }
        stripped = true;
        break; // One match per line is enough to strip it
      }
    }

    if (!stripped) {
      cleanLines.push(line);
    }
  }

  // Reassemble, collapsing excessive blank lines
  const sanitized = cleanLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  return {
    sanitized,
    strippedContent,
    patterns: matchedPatterns,
    version: patternVersion || 'n/a',
  };
}

/**
 * Get the loaded pattern version.
 */
export function getPatternVersion() {
  loadPatterns();
  return patternVersion;
}

// ============================================================
// Self-assessment & envelope stripping (ADR-021)
// ============================================================

/**
 * Self-assessment patterns that indicate LLM is scoring its own output.
 * Applied BEFORE reviewer sees output to prevent anchoring bias (P2).
 */
const SELF_ASSESSMENT_PATTERNS = [
  // "Quality Score: 8/10" or "Quality Score: 0.85"
  /(?:^|\n)[\s]*(?:quality|confidence|accuracy|performance)\s*(?:score|rating|level|assessment)\s*[:=]\s*[\d.]+(?:\s*\/\s*\d+)?[^\n]*/gi,
  // "Estimated accuracy: 95%"
  /(?:^|\n)[\s]*estimated\s+(?:accuracy|quality|confidence)\s*[:=]\s*[\d.]+%?[^\n]*/gi,
  // "Self-Assessment:" followed by content block
  /(?:^|\n)#{1,3}\s*(?:self[- ]?assessment|quality\s*(?:assessment|evaluation|check|score)|execution\s*report|task\s*completion\s*summary)[^\n]*(?:\n(?!#{1,3}\s)[^\n]*)*/gi,
  // "## Execution Report" blocks
  /(?:^|\n)#{1,3}\s*execution\s*report[^\n]*(?:\n(?!#{1,3}\s)[^\n]*)*/gi,
];

/**
 * Strip self-assessment artifacts and execution report envelopes from agent output.
 *
 * This is a deeper sanitization pass that complements the pattern-based sanitizeOutput().
 * Applied BEFORE reviewer sees output to prevent anchoring bias (P2).
 * All stripped content is logged for audit (P3).
 *
 * @param {string} output - Raw agent output
 * @param {Object} [options]
 * @param {string} [options.agentId] - For audit logging
 * @param {string} [options.workItemId] - For audit logging
 * @param {string} [options.expectedFormat] - 'html', 'json', 'sql', etc.
 * @returns {string} Sanitized output
 */
export function stripSelfAssessment(output, options = {}) {
  if (!output || typeof output !== 'string') return output || '';

  let result = output;
  const stripped = [];

  // --- Phase 1: Strip self-assessment blocks ---
  for (const pattern of SELF_ASSESSMENT_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    const matches = result.match(pattern);
    if (matches) {
      stripped.push(...matches.map(m => ({ type: 'self_assessment', content: m.trim().slice(0, 200) })));
      result = result.replace(pattern, '');
    }
  }

  // --- Phase 2: Strip execution report envelope ---
  // If output has a fenced code block and surrounding narrative > 2x code length,
  // extract the code block as the actual deliverable
  const codeBlockMatch = result.match(/```(\w*)\n([\s\S]*?)```/);
  if (codeBlockMatch) {
    const codeContent = codeBlockMatch[2];
    const codeLength = codeContent.length;
    const narrativeLength = result.length - codeBlockMatch[0].length;

    if (narrativeLength > codeLength * 2 && codeLength > 50) {
      stripped.push({
        type: 'envelope',
        narrativeLength,
        codeLength,
        ratio: (narrativeLength / codeLength).toFixed(1),
      });
      // Extract just the code content
      result = codeContent;
    }
  }

  // --- Cleanup: remove excessive blank lines ---
  result = result.replace(/\n{3,}/g, '\n\n').trim();

  // --- Audit log (P3: transparency by structure) ---
  if (stripped.length > 0) {
    const { agentId, workItemId } = options;
    log.info(`Stripped ${stripped.length} artifact(s) from ${agentId || 'unknown'} output (workItem: ${workItemId || 'n/a'})`);
    for (const s of stripped) {
      if (s.type === 'self_assessment') {
        log.info(`- self_assessment: "${s.content.slice(0, 80)}..."`);
      } else if (s.type === 'envelope') {
        log.info(`- envelope: ${s.narrativeLength} narrative / ${s.codeLength} code (${s.ratio}x)`);
      }
    }
  }

  return result;
}
