/**
 * LLM-backed fuzzy reconcile for signer redlines whose quoted_text no
 * longer appears verbatim in the current draft body — typically because
 * the board edited around that section after the signer viewed it.
 *
 * Used by /api/contracts/:id/proposals/:proposalId/accept when the fast
 * exact-substring path fails. The model receives the current body, the
 * signer's quoted excerpt, and the signer's proposed replacement, and
 * produces a revised full body that integrates the change in the
 * semantically correct location.
 *
 * Output guardrails mirror the main /edit endpoint: reject commentary,
 * reject responses that are >70% shorter than the input (model truncation),
 * strip markdown fences.
 */

const SYSTEM_PROMPT = `You reconcile a signer's suggested edit into a contract whose text has changed since the signer viewed it. The signer quoted a section and proposed a replacement; the current body has that section edited or moved.

Your job: return the full current contract body with the signer's proposed change integrated into the semantically correct location. Preserve everything else exactly.

Rules:
- Return the COMPLETE revised contract body. Your output replaces the entire document.
- Preserve the current body's structure, HTML tags, headings, and every unrelated clause verbatim.
- Integrate the proposed change so it reads naturally where the original quoted section now lives (or where the intent applies).
- If you cannot find a sensible place to integrate, or if the proposed change contradicts other edits the board already made, return the current body UNCHANGED and emit "SUMMARY: Could not reconcile — [reason]" as the last line.
- Do NOT add commentary, questions, or markdown code fences.
- On the final line only, emit "SUMMARY: " followed by a 10-15 word description of what you integrated (or the reason if unchanged).`;

/**
 * @param {Object} opts
 * @param {string} opts.currentBody
 * @param {string} opts.quoted
 * @param {string} opts.proposed
 * @returns {Promise<string|null>} reconciled body, or null if the model declined
 */
export async function llmReconcileRedline({ currentBody, quoted, proposed }) {
  const { createLLMClient, callProvider } = await import('../llm/provider.js');
  const { getConfig } = await import('../config/loader.js');
  const agentsConfig = getConfig('agents');
  const llm = createLLMClient('claude-haiku-4-5-20251001', agentsConfig.models);

  const userPrompt = `CURRENT CONTRACT BODY:
\`\`\`
${currentBody}
\`\`\`

SIGNER QUOTED (from when they viewed — may no longer appear verbatim):
\`\`\`
${quoted}
\`\`\`

SIGNER PROPOSED REPLACEMENT:
\`\`\`
${proposed}
\`\`\`

Return the full revised body followed by exactly one SUMMARY: line.`;

  const response = await callProvider(llm, {
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
    maxTokens: 8192,
    temperature: 0.1,
  });

  const fullText = (response.text || '').trim();
  const summaryMatch = fullText.match(/\n?SUMMARY:\s*(.+)$/m);
  const summary = summaryMatch ? summaryMatch[1].trim() : '';
  const newBody = (summaryMatch ? fullText.slice(0, summaryMatch.index) : fullText)
    .replace(/```(?:markdown|html)?\s*/g, '')
    .replace(/```\s*$/g, '')
    .trim();

  // Model explicitly refused — return null so caller keeps the 409.
  if (summary.startsWith('Could not reconcile')) return null;

  // Truncation guardrail — if the model returned dramatically less than
  // we sent, it's not a valid reconcile.
  if (newBody.length < currentBody.length * 0.3) return null;

  // Commentary guardrail — reject conversational leading text.
  const plainStart = newBody.replace(/<[^>]+>/g, '').trim();
  if (/^(I don't|I cannot|I can't|Unfortunately|I apologize|I'm sorry|I would need)/i.test(plainStart)) {
    return null;
  }

  return newBody;
}
