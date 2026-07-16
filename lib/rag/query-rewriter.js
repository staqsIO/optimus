/**
 * Query rewriter for RAG retrieval.
 *
 * Converts conversational board queries into search-optimized variants:
 * 1. Resolves coreferences ("it", "that", "the meeting") using chat history
 * 2. Generates 2-3 retrieval-optimized reformulations
 *
 * Uses Haiku (~$0.0003/call) — cheap enough for every query.
 * Falls back to original query if LLM call fails.
 *
 * Example:
 *   History: "We discussed NemoClaw architecture yesterday"
 *   Query: "What did we decide about it?"
 *   Rewritten: ["NemoClaw architecture decision", "NemoClaw sandbox vs MCP server"]
 */

import { createLLMClient, callProvider, computeCost } from '../llm/provider.js';

let _rewriterLLM = null;

function getRewriterLLM() {
  if (!_rewriterLLM) {
    // Use Haiku for cheap, fast query rewriting
    _rewriterLLM = createLLMClient('claude-haiku-4-5-20251001', {
      'claude-haiku-4-5-20251001': {
        provider: 'anthropic',
        inputCostPer1M: 0.80,
        outputCostPer1M: 4.00,
      },
    });
  }
  return _rewriterLLM;
}

const SYSTEM_PROMPT = `You are a search query optimizer for a knowledge base. Given a user's question and optional conversation history, generate 2-3 search-optimized queries that will find the most relevant documents.

Rules:
- Resolve pronouns and references using the conversation history
- Expand abbreviations and acronyms
- Include specific names, project names, and technical terms
- Each query should target a different aspect of the question
- Output ONLY a JSON array of strings, nothing else

Example:
History: "We talked about the deployment strategy for Optimus"
Question: "What did we decide?"
Output: ["Optimus deployment strategy decision", "Optimus Railway Vercel deployment architecture"]`;

/**
 * Rewrite a query into search-optimized variants.
 *
 * @param {string} query - The user's raw question
 * @param {Array<{role: string, content: string}>} [history=[]] - Recent conversation turns
 * @returns {Promise<string[]>} Array of optimized search queries (includes original)
 */
export async function rewriteQuery(query, history = []) {
  // Short queries or greetings don't need rewriting
  if (query.length < 15 || /^(hi|hello|hey|thanks|ok|yes|no)\b/i.test(query)) {
    return [query];
  }

  try {
    const llm = getRewriterLLM();
    const historyStr = history.length > 0
      ? `Recent conversation:\n${history.slice(-3).map(m => `${m.role}: ${m.content.slice(0, 200)}`).join('\n')}\n\n`
      : '';

    const response = await callProvider(llm, {
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `${historyStr}Question: ${query}` }],
      maxTokens: 200,
      temperature: 0.0,
    });

    const text = response.text?.trim();
    if (!text) return [query];

    // Parse JSON array
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed) && parsed.length > 0) {
      // Always include original query + rewrites
      const queries = [query, ...parsed.filter(q => typeof q === 'string' && q.length > 5)];
      // Deduplicate
      return [...new Set(queries)].slice(0, 4);
    }
  } catch {
    // LLM call or JSON parse failed — fall back to original
  }

  return [query];
}
