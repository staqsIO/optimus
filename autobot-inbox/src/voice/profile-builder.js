import { query } from '../db.js';

/**
 * Voice profile builder: analyzes sent emails to build writing profiles.
 * D3: Derived from sent mail analysis, not hand-authored.
 * Builds global profile + per-recipient profiles + per-topic profiles.
 */

/**
 * Build or update the global voice profile from all sent emails.
 * @param {string} [accountId] - Scope to a specific account (null for legacy/all)
 */
export async function buildGlobalProfile(accountId = null) {
  const params = [500];
  let accountClause = '';
  if (accountId) {
    params.push(accountId);
    accountClause = `WHERE account_id = $${params.length}`;
  }
  const result = await query(
    `SELECT body, to_address, subject, word_count
     FROM voice.sent_emails
     ${accountClause}
     ORDER BY sent_at DESC
     LIMIT $1`,
    params
  );

  if (result.rows.length === 0) return null;

  const analysis = analyzeEmails(result.rows);

  // Apply edit delta corrections to the base analysis
  const corrections = await analyzeEditDeltas();
  const correctedAnalysis = applyDeltaCorrections(analysis, corrections);

  // Upsert global profile (NULL scope_key needs special handling for UNIQUE constraint).
  // Account-scoped: each business gets its own global profile.
  // Wrapped in transaction to prevent data loss if process crashes between DELETE and INSERT.
  await query('BEGIN');
  try {
    if (accountId) {
      await query(
        `DELETE FROM voice.profiles WHERE scope = 'global' AND scope_key IS NULL AND account_id = $1`,
        [accountId]
      );
    } else {
      await query(
        `DELETE FROM voice.profiles WHERE scope = 'global' AND scope_key IS NULL AND account_id IS NULL`
      );
    }
    await query(
      `INSERT INTO voice.profiles (scope, scope_key, greetings, closings, vocabulary, tone_markers, avg_length, formality_score, sample_count, account_id)
       VALUES ('global', NULL, $1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        correctedAnalysis.greetings,
        correctedAnalysis.closings,
        JSON.stringify(correctedAnalysis.vocabulary),
        JSON.stringify(correctedAnalysis.toneMarkers),
        correctedAnalysis.avgLength,
        correctedAnalysis.formalityScore,
        result.rows.length,
        accountId || null,
      ]
    );
    await query('COMMIT');
  } catch (err) {
    await query('ROLLBACK');
    throw err;
  }

  return correctedAnalysis;
}

/**
 * Build per-recipient voice profiles.
 * @param {string} [accountId] - Scope to a specific account (null for legacy/all)
 */
export async function buildRecipientProfiles(accountId = null) {
  const params = [3];
  let accountClause = '';
  if (accountId) {
    params.push(accountId);
    accountClause = `WHERE account_id = $${params.length}`;
  }
  const recipients = await query(
    `SELECT DISTINCT to_address FROM voice.sent_emails
     ${accountClause}
     GROUP BY to_address HAVING COUNT(*) >= $1`,
    params
  );

  for (const { to_address } of recipients.rows) {
    const emailParams = [to_address, 50];
    let emailAccountClause = '';
    if (accountId) {
      emailParams.push(accountId);
      emailAccountClause = `AND account_id = $${emailParams.length}`;
    }
    const emails = await query(
      `SELECT body, subject, word_count FROM voice.sent_emails
       WHERE to_address = $1 ${emailAccountClause}
       ORDER BY sent_at DESC LIMIT $2`,
      emailParams
    );

    const analysis = analyzeEmails(emails.rows);

    // Apply recipient-scoped edit delta corrections
    const corrections = await analyzeEditDeltas(to_address);
    const correctedAnalysis = applyDeltaCorrections(analysis, corrections);

    // Use DELETE + INSERT to handle the new composite unique index (scope, scope_key, account_id)
    await query('BEGIN');
    try {
      if (accountId) {
        await query(
          `DELETE FROM voice.profiles WHERE scope = 'recipient' AND scope_key = $1 AND account_id = $2`,
          [to_address, accountId]
        );
      } else {
        await query(
          `DELETE FROM voice.profiles WHERE scope = 'recipient' AND scope_key = $1 AND account_id IS NULL`,
          [to_address]
        );
      }
      await query(
        `INSERT INTO voice.profiles (scope, scope_key, greetings, closings, vocabulary, tone_markers, avg_length, formality_score, sample_count, account_id)
         VALUES ('recipient', $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          to_address,
          correctedAnalysis.greetings,
          correctedAnalysis.closings,
          JSON.stringify(correctedAnalysis.vocabulary),
          JSON.stringify(correctedAnalysis.toneMarkers),
          correctedAnalysis.avgLength,
          correctedAnalysis.formalityScore,
          emails.rows.length,
          accountId || null,
        ]
      );
      await query('COMMIT');
    } catch (err) {
      await query('ROLLBACK');
      throw err;
    }
  }
}

/**
 * Get the best voice profile for a recipient.
 * Falls back: account-scoped recipient → account-scoped global → any global → null.
 * @param {string} recipientEmail - Recipient email address
 * @param {string} [accountId] - Account to scope voice to (prevents cross-contamination)
 */
export async function getProfile(recipientEmail, accountId = null) {
  // Try account-scoped recipient profile first
  if (recipientEmail && accountId) {
    const scopedRecipient = await query(
      `SELECT * FROM voice.profiles WHERE scope = 'recipient' AND scope_key = $1 AND account_id = $2`,
      [recipientEmail, accountId]
    );
    if (scopedRecipient.rows.length > 0) return scopedRecipient.rows[0];
  }

  // Fall back to any recipient profile (legacy/unscoped)
  if (recipientEmail) {
    const recipientProfile = await query(
      `SELECT * FROM voice.profiles WHERE scope = 'recipient' AND scope_key = $1 ORDER BY account_id = $2 DESC NULLS LAST LIMIT 1`,
      [recipientEmail, accountId]
    );
    if (recipientProfile.rows.length > 0) return recipientProfile.rows[0];
  }

  // Account-scoped global profile
  if (accountId) {
    const scopedGlobal = await query(
      `SELECT * FROM voice.profiles WHERE scope = 'global' AND account_id = $1 LIMIT 1`,
      [accountId]
    );
    if (scopedGlobal.rows.length > 0) return scopedGlobal.rows[0];
  }

  // Fall back to any global profile
  const globalProfile = await query(
    `SELECT * FROM voice.profiles WHERE scope = 'global' ORDER BY account_id IS NULL DESC LIMIT 1`
  );
  return globalProfile.rows[0] || null;
}

/**
 * Analyze edit deltas to extract correction patterns.
 * Groups by edit type, extracts recurring corrections, weights by recency.
 * @param {string} [recipient] - Scope to a specific recipient (null for global)
 * @returns {Object} Corrections: { greetings, closings, vocabularyOverrides, formalityCorrection }
 */
export async function analyzeEditDeltas(recipient = null) {
  const empty = { greetings: [], closings: [], vocabularyOverrides: {}, formalityCorrection: 0 };

  const params = [90];
  let recipientClause = '';
  if (recipient) {
    params.push(recipient);
    recipientClause = `AND recipient = $${params.length}`;
  }

  const result = await query(
    `SELECT original_body, edited_body, edit_type, edit_magnitude, created_at
     FROM voice.edit_deltas
     WHERE created_at >= CURRENT_DATE - $1 * interval '1 day'
       ${recipientClause}
     ORDER BY created_at DESC`,
    params
  );

  if (result.rows.length === 0) return empty;

  const greetingCorrections = {};
  const closingCorrections = {};
  const wordReplacements = {};
  let formalityShift = 0;
  let formalitySamples = 0;

  for (const delta of result.rows) {
    const origLines = (delta.original_body || '').split('\n').map(l => l.trim()).filter(Boolean);
    const editLines = (delta.edited_body || '').split('\n').map(l => l.trim()).filter(Boolean);

    // Recency weight: 1.0 for today → 0.5 for 90 days ago (oldest in window).
    // Denominator is 180 so the floor is 0.5 at the 90-day edge — old edits still count, just less.
    const daysAgo = (Date.now() - new Date(delta.created_at).getTime()) / (1000 * 60 * 60 * 24);
    const weight = 1.0 - (daysAgo / 180);

    // Detect greeting corrections (first line changes)
    if (origLines.length > 0 && editLines.length > 0) {
      const origGreeting = origLines[0].match(/^(Hi|Hey|Hello|Dear|Good morning|Good afternoon)[,!]?\s*/i);
      const editGreeting = editLines[0].match(/^(Hi|Hey|Hello|Dear|Good morning|Good afternoon)[,!]?\s*/i);
      if (origGreeting && editGreeting && origGreeting[0] !== editGreeting[0]) {
        const corrected = editGreeting[0].trim().replace(/[,!]\s*$/, '');
        greetingCorrections[corrected] = (greetingCorrections[corrected] || 0) + weight;
      }
    }

    // Detect closing corrections (last few lines)
    const origLast = origLines.slice(-3);
    const editLast = editLines.slice(-3);
    for (const line of editLast) {
      const closingMatch = line.match(/^(Best|Thanks|Thank you|Cheers|Regards|Talk soon|Chat soon|Take care|- E)[,!.]?\s*$/i);
      if (closingMatch) {
        const corrected = closingMatch[0].trim().replace(/[,!.]\s*$/, '');
        // Only count if original had a different closing
        const origHadDifferentClosing = origLast.some(ol => {
          const m = ol.match(/^(Best|Thanks|Thank you|Cheers|Regards|Talk soon|Chat soon|Take care|- E)[,!.]?\s*$/i);
          return m && m[0].trim().replace(/[,!.]\s*$/, '') !== corrected;
        });
        if (origHadDifferentClosing) {
          closingCorrections[corrected] = (closingCorrections[corrected] || 0) + weight;
        }
      }
    }

    // Detect vocabulary overrides: words consistently changed
    const origWords = (delta.original_body || '').toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
    const editWords = (delta.edited_body || '').toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
    const origSet = new Set(origWords);
    const editSet = new Set(editWords);
    for (const word of editSet) {
      if (!origSet.has(word) && word.length >= 4) {
        wordReplacements[word] = (wordReplacements[word] || 0) + weight;
      }
    }

    // Formality shift detection
    const origFormal = /\b(Dear|Regards|Sincerely|Please find|Kindly)\b/i.test(delta.original_body || '');
    const editFormal = /\b(Dear|Regards|Sincerely|Please find|Kindly)\b/i.test(delta.edited_body || '');
    if (origFormal && !editFormal) { formalityShift -= weight; formalitySamples++; }
    if (!origFormal && editFormal) { formalityShift += weight; formalitySamples++; }
  }

  // Build corrections from most frequent patterns
  const greetings = Object.entries(greetingCorrections)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([g]) => g);

  const closings = Object.entries(closingCorrections)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([c]) => c);

  // Vocabulary overrides: only include words that appear in 2+ corrections
  const vocabularyOverrides = {};
  for (const [word, count] of Object.entries(wordReplacements)) {
    if (count >= 2) vocabularyOverrides[word] = Math.round(count);
  }

  const formalityCorrection = formalitySamples > 0
    ? +(formalityShift / formalitySamples).toFixed(2)
    : 0;

  return { greetings, closings, vocabularyOverrides, formalityCorrection };
}

/**
 * Apply edit delta corrections to a base voice analysis.
 * Merges correction patterns into the profile: greeting/closing overrides,
 * formality adjustment, vocabulary additions.
 */
export function applyDeltaCorrections(baseAnalysis, corrections) {
  if (!corrections || (corrections.greetings?.length === 0 && corrections.closings?.length === 0
      && Object.keys(corrections.vocabularyOverrides || {}).length === 0 && corrections.formalityCorrection === 0)) {
    return baseAnalysis;
  }

  const corrected = { ...baseAnalysis };

  // Override greetings: put corrected ones first, then keep originals
  if (corrections.greetings.length > 0) {
    const existing = baseAnalysis.greetings.filter(g => !corrections.greetings.includes(g));
    corrected.greetings = [...corrections.greetings, ...existing].slice(0, 5);
  }

  // Override closings: put corrected ones first
  if (corrections.closings.length > 0) {
    const existing = baseAnalysis.closings.filter(c => !corrections.closings.includes(c));
    corrected.closings = [...corrections.closings, ...existing].slice(0, 5);
  }

  // Adjust formality score (clamp to 0-1)
  if (corrections.formalityCorrection !== 0) {
    const adjusted = baseAnalysis.formalityScore + corrections.formalityCorrection;
    corrected.formalityScore = +Math.max(0, Math.min(1, adjusted)).toFixed(2);
  }

  // Merge vocabulary overrides into existing vocabulary
  if (Object.keys(corrections.vocabularyOverrides).length > 0) {
    const vocab = { ...baseAnalysis.vocabulary };
    for (const [word, count] of Object.entries(corrections.vocabularyOverrides)) {
      vocab[word] = (vocab[word] || 0) + count;
    }
    corrected.vocabulary = vocab;
  }

  // Copy tone markers (unmodified — tone corrections affect formality, not markers)
  corrected.toneMarkers = { ...baseAnalysis.toneMarkers };

  return corrected;
}

/**
 * Check if voice profiles should be rebuilt based on accumulated edit deltas.
 * @param {string} [scope] - 'global' or recipient email
 * @returns {Promise<boolean>}
 */
export async function shouldRebuild(scope = 'global') {
  const REBUILD_THRESHOLD = 5;

  // Get last rebuild time from profile
  let lastRebuild;
  if (scope === 'global') {
    const result = await query(
      `SELECT last_updated FROM voice.profiles WHERE scope = 'global' LIMIT 1`
    );
    lastRebuild = result.rows[0]?.last_updated;
  } else {
    const result = await query(
      `SELECT last_updated FROM voice.profiles WHERE scope = 'recipient' AND scope_key = $1`,
      [scope]
    );
    lastRebuild = result.rows[0]?.last_updated;
  }

  // Count edits since last rebuild
  const params = [];
  let dateClause = '';
  if (lastRebuild) {
    params.push(lastRebuild);
    dateClause = `WHERE created_at > $${params.length}`;
  }

  if (scope !== 'global') {
    params.push(scope);
    dateClause += (dateClause ? ' AND' : 'WHERE') + ` recipient = $${params.length}`;
  }

  const result = await query(
    `SELECT COUNT(*) AS cnt FROM voice.edit_deltas ${dateClause}`,
    params
  );

  return parseInt(result.rows[0].cnt) >= REBUILD_THRESHOLD;
}

/**
 * Rebuild all voice profiles with current edit delta corrections.
 * Called manually via CLI/API or triggered when edit count exceeds threshold.
 * Multi-account: rebuilds per-account profiles for each active account, plus legacy (null).
 */
export async function rebuildAllProfiles() {
  const start = Date.now();

  // Get all active accounts to build per-account profiles
  const accountsResult = await query(
    `SELECT id FROM inbox.accounts WHERE channel = 'email' AND is_active = true`
  );
  const accountIds = accountsResult.rows.map(r => r.id);

  // Build per-account profiles
  for (const acctId of accountIds) {
    await buildGlobalProfile(acctId);
    await buildRecipientProfiles(acctId);
  }

  // Also rebuild legacy/unscoped profiles (for pre-multi-account data)
  const globalResult = await buildGlobalProfile();
  await buildRecipientProfiles();
  const elapsed = Date.now() - start;

  // Count what was rebuilt (delta count scoped to 90-day analysis window)
  const profileCount = await query(`SELECT COUNT(*) AS cnt FROM voice.profiles`);
  const deltaCount = await query(
    `SELECT COUNT(*) AS cnt FROM voice.edit_deltas WHERE created_at >= CURRENT_DATE - interval '90 days'`
  );

  return {
    profilesRebuilt: parseInt(profileCount.rows[0].cnt),
    deltasAnalyzed: parseInt(deltaCount.rows[0].cnt),
    elapsedMs: elapsed,
    globalProfile: globalResult != null,
  };
}

/**
 * Strip quoted reply chains and signatures from email body.
 * Returns only the author's own text.
 */
function stripQuotedContent(body) {
  if (!body) return '';
  const lines = body.split('\n');
  const cleanLines = [];
  for (const line of lines) {
    const trimmed = line.trim();
    // Stop at quoted reply markers
    if (/^On .+wrote:\s*$/i.test(trimmed)) break;
    if (/^-{3,}\s*(Forwarded|Original)\s+message/i.test(trimmed)) break;
    if (/^>{1,2}\s/.test(trimmed)) continue; // skip > quoted lines
    // Stop at common email signatures
    if (/^--\s*$/.test(trimmed)) break;
    if (/^_{3,}$/.test(trimmed)) break;
    // Skip image placeholders and links-only lines
    if (/^\[image:/.test(trimmed)) continue;
    cleanLines.push(line);
  }
  return cleanLines.join('\n').trim();
}

/**
 * Analyze a set of emails for voice patterns.
 */
function analyzeEmails(emails) {
  const greetingCounts = {};
  const closingCounts = {};
  const wordFreq = {};
  let totalWords = 0;
  let formalCount = 0;
  let exclamationCount = 0;
  let contractionCount = 0;
  let emDashCount = 0;
  let questionCount = 0;
  const sentenceLengths = [];

  for (const email of emails) {
    const body = stripQuotedContent(email.body || '');
    if (!body || body.length < 10) continue; // skip empty after stripping
    const lines = body.split('\n').map(l => l.trim()).filter(Boolean);

    // Detect greetings (first line)
    if (lines.length > 0) {
      const firstLine = lines[0];
      const greetingMatch = firstLine.match(/^(Hi|Hey|Hello|Dear|Good morning|Good afternoon|Good evening|Thanks|Thank you)[,!]?\s*/i);
      if (greetingMatch) {
        const greeting = greetingMatch[0].trim().replace(/[,!]\s*$/, '');
        greetingCounts[greeting] = (greetingCounts[greeting] || 0) + 1;
      }
    }

    // Detect closings (last few lines)
    const lastLines = lines.slice(-3);
    for (const line of lastLines) {
      const closingMatch = line.match(/^(Best|Thanks|Thank you|Cheers|Regards|Best regards|Warm regards|Talk soon|Chat soon|Take care|Sincerely|All the best)[,!.]?\s*$/i);
      if (closingMatch) {
        const closing = closingMatch[0].trim().replace(/[,!.]\s*$/, '');
        closingCounts[closing] = (closingCounts[closing] || 0) + 1;
      }
    }

    // Word frequency (skip common words)
    const words = body.toLowerCase().match(/\b[a-z]{4,}\b/g) || [];
    totalWords += words.length;
    for (const word of words) {
      if (!STOP_WORDS.has(word)) {
        wordFreq[word] = (wordFreq[word] || 0) + 1;
      }
    }

    // Formality heuristic
    if (/\b(Dear|Regards|Sincerely|Please find|Kindly)\b/i.test(body)) {
      formalCount++;
    }

    // Style markers
    exclamationCount += (body.match(/!/g) || []).length;
    contractionCount += (body.match(/\b(I'm|we're|don't|doesn't|won't|can't|I've|I'd|it's|that's|there's|let's|here's|what's|you're|they're|we've|we'll|I'll|you'll)\b/gi) || []).length;
    emDashCount += (body.match(/\u2014/g) || []).length; // em-dash —
    questionCount += (body.match(/\?/g) || []).length;

    // Sentence length
    const sentences = body.split(/[.!?]+/).filter(s => s.trim().length > 5);
    for (const s of sentences) {
      const wc = s.trim().split(/\s+/).length;
      if (wc > 1) sentenceLengths.push(wc);
    }
  }

  const validCount = emails.filter(e => stripQuotedContent(e.body || '').length >= 10).length || 1;

  const greetings = Object.entries(greetingCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([g]) => g);

  const closings = Object.entries(closingCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([c]) => c);

  const topWords = Object.entries(wordFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50)
    .reduce((acc, [w, c]) => ({ ...acc, [w]: c }), {});

  const avgSentenceLength = sentenceLengths.length > 0
    ? Math.round(sentenceLengths.reduce((a, b) => a + b, 0) / sentenceLengths.length)
    : 0;

  return {
    greetings,
    closings,
    vocabulary: topWords,
    toneMarkers: {
      formalRatio: validCount > 0 ? formalCount / validCount : 0,
      exclamationsPerEmail: +(exclamationCount / validCount).toFixed(1),
      contractionsPerEmail: +(contractionCount / validCount).toFixed(1),
      emDashesPerEmail: +(emDashCount / validCount).toFixed(2),
      questionsPerEmail: +(questionCount / validCount).toFixed(1),
      avgSentenceLength,
    },
    avgLength: validCount > 0 ? Math.round(totalWords / validCount) : 0,
    formalityScore: validCount > 0 ? +(formalCount / validCount).toFixed(2) : 0.5,
  };
}

const STOP_WORDS = new Set([
  'that', 'this', 'with', 'have', 'will', 'from', 'they', 'been', 'said',
  'each', 'which', 'their', 'time', 'about', 'would', 'make', 'like',
  'just', 'over', 'such', 'than', 'them', 'very', 'when', 'come', 'could',
  'more', 'some', 'also', 'into', 'your', 'only', 'other', 'then', 'what',
  'know', 'take', 'people', 'into', 'year', 'good', 'give', 'most',
]);
