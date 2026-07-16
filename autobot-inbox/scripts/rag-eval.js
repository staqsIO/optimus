#!/usr/bin/env node
/**
 * RAG Evaluation Pipeline (P0)
 *
 * Runs golden Q&A pairs against the retriever, measures:
 * - Hit Rate: % of queries where at least 1 relevant chunk was retrieved
 * - Keyword Recall: % of expected keywords found in retrieved chunks
 * - MRR (Mean Reciprocal Rank): how high the first relevant chunk ranks
 * - Latency: p50, p95, p99 retrieval time
 *
 * Usage:
 *   node scripts/rag-eval.js                    # Run full eval
 *   node scripts/rag-eval.js --verbose           # Show per-query details
 */

import 'dotenv/config';
import { readFileSync } from 'fs';
import { searchChunks } from '../../lib/rag/retriever.js';

const GOLDEN_PATH = new URL('../test/rag-eval-golden.json', import.meta.url);
const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf-8'));
const verbose = process.argv.includes('--verbose');

async function evaluateQuery(item) {
  const start = Date.now();
  const result = await searchChunks(item.question, { matchCount: 10, maxClassification: 'INTERNAL' });
  const latencyMs = Date.now() - start;

  if (!result || result.chunks.length === 0) {
    return { question: item.question, hitRate: 0, keywordRecall: 0, mrr: 0, latencyMs, chunks: 0 };
  }

  const allText = result.chunks.map(c => c.text.toLowerCase()).join(' ');
  const keywords = item.expected_keywords || [];
  const foundKeywords = keywords.filter(kw => allText.includes(kw.toLowerCase()));
  const keywordRecall = keywords.length > 0 ? foundKeywords.length / keywords.length : 0;

  // Hit rate: did we find at least 1 chunk with any expected keyword?
  const hitRate = foundKeywords.length > 0 ? 1 : 0;

  // MRR: reciprocal rank of first chunk containing any keyword
  let mrr = 0;
  for (let i = 0; i < result.chunks.length; i++) {
    const chunkText = result.chunks[i].text.toLowerCase();
    if (keywords.some(kw => chunkText.includes(kw.toLowerCase()))) {
      mrr = 1 / (i + 1);
      break;
    }
  }

  return {
    question: item.question,
    hitRate,
    keywordRecall,
    mrr,
    latencyMs,
    chunks: result.chunks.length,
    foundKeywords,
    missedKeywords: keywords.filter(kw => !foundKeywords.includes(kw)),
    topSimilarity: result.chunks[0]?.similarity?.toFixed(3),
  };
}

async function main() {
  console.log(`RAG Evaluation Pipeline`);
  console.log(`======================`);
  console.log(`Golden dataset: ${golden.length} queries\n`);

  const results = [];
  for (const item of golden) {
    try {
      const result = await evaluateQuery(item);
      results.push(result);

      if (verbose) {
        const status = result.hitRate ? '\u2713' : '\u2717';
        console.log(`${status} ${result.question}`);
        console.log(`  Recall: ${(result.keywordRecall * 100).toFixed(0)}% | MRR: ${result.mrr.toFixed(2)} | Latency: ${result.latencyMs}ms | Top sim: ${result.topSimilarity}`);
        if (result.missedKeywords?.length > 0) {
          console.log(`  Missed: ${result.missedKeywords.join(', ')}`);
        }
        console.log();
      }
    } catch (err) {
      console.error(`Error on "${item.question}": ${err.message}`);
      results.push({ question: item.question, hitRate: 0, keywordRecall: 0, mrr: 0, latencyMs: 0, chunks: 0 });
    }
  }

  // Aggregate metrics
  const n = results.length;
  const avgHitRate = results.reduce((s, r) => s + r.hitRate, 0) / n;
  const avgKeywordRecall = results.reduce((s, r) => s + r.keywordRecall, 0) / n;
  const avgMRR = results.reduce((s, r) => s + r.mrr, 0) / n;

  const latencies = results.map(r => r.latencyMs).sort((a, b) => a - b);
  const p50 = latencies[Math.floor(n * 0.5)];
  const p95 = latencies[Math.floor(n * 0.95)];
  const p99 = latencies[Math.floor(n * 0.99)];

  console.log(`\nResults`);
  console.log(`-------`);
  console.log(`Hit Rate:        ${(avgHitRate * 100).toFixed(1)}%`);
  console.log(`Keyword Recall:  ${(avgKeywordRecall * 100).toFixed(1)}%`);
  console.log(`MRR:             ${avgMRR.toFixed(3)}`);
  console.log(`Latency p50:     ${p50}ms`);
  console.log(`Latency p95:     ${p95}ms`);
  console.log(`Latency p99:     ${p99}ms`);
  console.log(`\nQueries: ${n} | Hits: ${results.filter(r => r.hitRate).length} | Misses: ${results.filter(r => !r.hitRate).length}`);

  // Grade
  if (avgHitRate >= 0.8 && avgKeywordRecall >= 0.5) {
    console.log(`\n\u2705 PASS — retrieval quality is acceptable`);
  } else {
    console.log(`\n\u26A0\uFE0F  BELOW THRESHOLD — consider reranking or query rewriting`);
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
