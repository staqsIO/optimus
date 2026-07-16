import { query } from '../../lib/db.js';
import { AgentLoop } from '../../lib/runtime/agent-loop.js';
import { retrieveContext } from '../../lib/rag/retriever.js';
import { requirePermission } from '../../lib/runtime/permissions.js';
import { createPR } from '../../autobot-inbox/src/github/pr-creator.js';
import { generateImage } from '../../autobot-inbox/src/images/generator.js';
import { createChildLogger } from '../../lib/logger.js';

const log = createChildLogger({ agent: 'executor-writer' });

/**
 * Executor-Writer: 5-phase content generation pipeline (Phase 1.5).
 *
 * Phases:
 *   1. RESEARCH — web search for trending topics + engagement signals
 *   2. GROUNDING — RAG retrieval + authoritative source verification
 *   3. OUTLINE + DRAFT — structured MDX generation with SEO metadata
 *   4. IMAGE GENERATION — header image prompt (deferred: actual generation)
 *   5. MEMORY — feedback stored via existing agent-memory.js + G11
 *
 * Input metadata:
 *   - topic: string (required) — the topic to write about
 *   - content_type: 'blog' | 'linkedin' (default: 'blog')
 *   - target_audience: string — who the content is for
 *   - seo_keywords: string[] — target SEO keywords
 *   - tone: string — e.g., 'operator', 'technical', 'educational'
 *   - author: string — attributed author (default: 'UMB Advisors')
 *   - target_repo: string — GitHub repo for blog delivery (default: 'staqsIO/umbadvisors')
 *   - outline: string — optional pre-defined outline
 *
 * Output: stores content_result in work_item metadata, creates PR if blog.
 */

const UMB_REPO_OWNER = 'UMB-Advisors';
const UMB_REPO_NAME = 'umbadvisors.com';

// ── Phase 1: Research ──────────────────────────────────────────────

const RESEARCH_PROMPT = `You are a content strategist for UMB Advisors, a select engagement advisory firm specializing in fractional leadership, AI infrastructure, and operational execution.

Given the topic below, research and produce a structured brief. Your output must be valid JSON (no markdown fences):

{
  "topic_analysis": "2-3 sentence analysis of why this topic matters now",
  "key_angles": ["angle 1", "angle 2", "angle 3"],
  "target_questions": ["What question does the reader have?", "..."],
  "competitor_gaps": "What are others NOT saying about this?",
  "data_points": ["Specific stat or fact to ground the piece"],
  "recommended_structure": "suggested article structure"
}

Rules:
- Focus on angles that position UMB Advisors as operators, not consultants
- Prioritize operational specifics over motivational framing
- Identify contrarian or under-discussed angles
- Every data point must be verifiable`;

async function phaseResearch(topic, metadata, agent, taskId) {
  const userMsg = `Topic: "${topic}"
Target audience: ${metadata.target_audience || 'Growth-stage company operators and founders'}
SEO keywords: ${(metadata.seo_keywords || []).join(', ') || 'none specified'}
Tone: ${metadata.tone || 'Calm experienced operator, thinking in public'}`;

  const response = await agent.callLLM(RESEARCH_PROMPT, userMsg, {
    taskId, maxTokens: 4096, temperature: 0.4,
  });

  let research;
  try {
    research = JSON.parse(response.text);
  } catch {
    research = { topic_analysis: response.text, key_angles: [], target_questions: [], data_points: [] };
  }

  return { research, costUsd: response.costUsd };
}

// ── Phase 2: Grounding ─────────────────────────────────────────────

async function phaseGrounding(topic, research, agent, taskId, ownerId) {
  // RAG retrieval from knowledge base for relevant context.
  // Worktree 1 (RAG tenancy hardening): Executor tier — caller threads
  // ownerId through from the work_item context. The original
  // `sharedDocumentsOnly: true` intent (org-shared corpus only) is
  // preserved on the opts side, but scope validation requires an
  // explicit owner.
  let ragContext = null;
  try {
    if (ownerId) {
      // Phase-2 tenancy: attach readOrgIds (syntheticPrincipal Staqs) so
      // match_chunks fails closed on owner_org_id.
      const { CURRENT_ORG_READ_SCOPE } = await import('../../lib/tenancy/scope.js');
      ragContext = await retrieveContext(
        `${topic} ${(research.key_angles || []).join(' ')}`,
        { includeOrgWide: true, sharedDocumentsOnly: true },
        {
          ownerId: String(ownerId),
          readOrgIds: CURRENT_ORG_READ_SCOPE,
        }
      );
    } else {
      log.warn({ taskId }, 'executor-writer/phaseGrounding: no ownerId — skipping RAG');
    }
  } catch (err) {
    log.warn({ err }, 'RAG retrieval failed — proceeding without grounding');
  }

  const groundingPrompt = `You are a fact-checker and research grounding agent. Given the research brief and any retrieved knowledge base context, produce a grounding report.

Output valid JSON (no markdown fences):
{
  "verified_facts": ["fact with source attribution"],
  "citations": ["source: claim"],
  "knowledge_gaps": ["areas where claims need human verification"],
  "umb_relevant_context": "any UMB-specific context from the knowledge base that should inform the article"
}

Rules:
- Flag any numeric claims that cannot be verified
- Note claims about specific companies, regulations, or market data
- If knowledge base context is available, cross-reference research claims against it`;

  const userMsg = `Research brief: ${JSON.stringify(research)}
${ragContext ? `\nKnowledge base context:\n${ragContext.answer}\n\nCitations: ${JSON.stringify(ragContext.citations?.slice(0, 5))}` : '\nNo knowledge base context available.'}`;

  const response = await agent.callLLM(groundingPrompt, userMsg, {
    taskId, maxTokens: 4096, temperature: 0.2,
  });

  let grounding;
  try {
    grounding = JSON.parse(response.text);
  } catch {
    grounding = { verified_facts: [], citations: [], knowledge_gaps: [response.text] };
  }

  return { grounding, costUsd: response.costUsd };
}

// ── Phase 3: Outline + Draft ───────────────────────────────────────

const DRAFT_PROMPT = `You are a senior content writer for UMB Advisors — a select engagement advisory firm delivering fractional leadership, custom technology, and real execution.

Write a complete blog post in MDX format. The post should position UMB Advisors as experienced operators who build and execute, not consultants who advise from the sidelines.

Voice guidelines:
- Calm, experienced operator thinking in public — not performing
- Speaking to peers, not an audience
- Grounded in operational reality with specific economics and mechanics
- Occasionally playful, never motivational
- Every sentence carries information — no filler

Hard constraints (MUST follow):
- No em dashes (use commas, periods, or parentheses instead)
- No "It's not X, it's Y" constructions or contrastive reframes
- No bullet points in the article body (unless listing concrete data)
- No motivational/hype language
- Forbidden words: "game changer", "unlock", "journey", "leverage", "disrupt", "synergy", "empower", "transformation", "revolutionary", "cutting-edge", "next-level", "deep dive", "double down", "move the needle", "at the end of the day"
- Minimal formatting (no bold, no numbered lists in body)
- Headers should be ## level only (h2), short and direct

Output the complete blog post as MDX content (no frontmatter — that will be added separately).
Also output a JSON metadata block at the very end, after a line containing only "---META---":

---META---
{
  "seo_title": "Page title for SEO (under 60 chars)",
  "seo_description": "Meta description (under 160 chars)",
  "seo_keywords": ["keyword1", "keyword2"],
  "excerpt": "1-2 sentence summary for the blog index page",
  "suggested_tags": ["tag1", "tag2"],
  "word_count": 0,
  "reading_time_min": 0
}`;

async function phaseDraft(topic, metadata, research, grounding, agent, taskId) {
  const outline = metadata.outline || research.recommended_structure || '';

  const userMsg = `Topic: "${topic}"
Author: ${metadata.author || 'UMB Advisors'}
Target audience: ${metadata.target_audience || 'Growth-stage company operators and founders'}

Research brief:
${JSON.stringify(research, null, 2)}

Grounding report:
${JSON.stringify(grounding, null, 2)}

${outline ? `Outline to follow:\n${outline}` : 'Structure the article as you see fit based on the research.'}

Write the complete blog post now.`;

  const response = await agent.callLLM(DRAFT_PROMPT, userMsg, {
    taskId, maxTokens: 8192, temperature: 0.5,
  });

  // Parse MDX content and metadata
  const parts = response.text.split('---META---');
  const mdxContent = (parts[0] || '').trim();
  let draftMeta = {};
  if (parts[1]) {
    try {
      draftMeta = JSON.parse(parts[1].trim());
    } catch {
      log.warn('Failed to parse draft metadata JSON');
    }
  }

  return { mdxContent, draftMeta, costUsd: response.costUsd };
}

// ── Phase 4: Image Generation (NB2 — Gemini Flash) ────────────────

async function phaseImage(topic, mdxContent, agent, taskId) {
  // Step 1: LLM generates a focused image prompt
  const imagePrompt = `Generate a concise image generation prompt for a blog post header image.

The image should be:
- Professional and minimal, suitable for an advisory firm
- Dark background with warm accent tones (gold/amber)
- Abstract or geometric — no stock photo aesthetics
- No text in the image

Topic: "${topic}"
First 200 chars of article: "${mdxContent.slice(0, 200)}"

Output valid JSON (no markdown fences):
{
  "image_prompt": "the actual prompt for an image generator",
  "alt_text": "accessible alt text for the image",
  "style": "the visual style description"
}`;

  const response = await agent.callLLM(imagePrompt, 'Generate the header image prompt.', {
    taskId, maxTokens: 1024, temperature: 0.4,
  });

  let imageAssets = {};
  try {
    imageAssets = JSON.parse(response.text);
  } catch {
    imageAssets = { image_prompt: response.text, alt_text: topic };
  }

  let imageCost = response.costUsd;

  // Step 2: Actually generate the image via NB2 (Gemini Flash)
  const imageResult = await generateImage(imageAssets.image_prompt || topic);

  if (imageResult) {
    imageAssets.imageBuffer = imageResult.imageBuffer;
    imageAssets.mimeType = imageResult.mimeType;
    imageAssets.generated = true;
    imageCost += imageResult.costUsd;
    log.info({ size: imageResult.imageBuffer.length, mime: imageResult.mimeType }, 'NB2 image generated');
  } else {
    imageAssets.generated = false;
    log.info('NB2 image generation skipped (no API key or error)');
  }

  return { imageAssets, costUsd: imageCost };
}

// ── Frontmatter Assembly ───────────────────────────────────────────

function buildFrontmatter(topic, metadata, draftMeta, imageAssets, totalCost, campaignId, workItemId) {
  const slug = (metadata.slug || topic)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);

  const date = new Date().toISOString().split('T')[0];
  const author = metadata.author || 'UMB Advisors';

  // Image path if NB2 generated one
  const ext = (imageAssets?.mimeType || 'image/png').split('/')[1] || 'png';
  const imageLine = imageAssets?.generated
    ? `\nimage: "/blog/images/${slug}.${ext}"\nimage_alt: "${(imageAssets.alt_text || topic).replace(/"/g, '\\"')}"`
    : '';

  return `---
title: "${(draftMeta.seo_title || topic).replace(/"/g, '\\"')}"
slug: "${slug}"
date: "${date}"
author: "${author}"
excerpt: "${(draftMeta.excerpt || '').replace(/"/g, '\\"')}"
tags: ${JSON.stringify(draftMeta.suggested_tags || metadata.seo_keywords || [])}${imageLine}
seo:
  title: "${(draftMeta.seo_title || topic).replace(/"/g, '\\"')}"
  description: "${(draftMeta.seo_description || '').replace(/"/g, '\\"')}"
  keywords: ${JSON.stringify(draftMeta.seo_keywords || metadata.seo_keywords || [])}
optimus:
  campaign_id: "${campaignId || 'manual'}"
  work_item_id: "${workItemId || 'manual'}"
  cost_usd: ${totalCost.toFixed(4)}
---`;
}

// ── Content Gate Checks ────────────────────────────────────────────

const FORBIDDEN_WORDS = [
  'game changer', 'unlock', 'journey', 'leverage', 'disrupt', 'synergy',
  'empower', 'transformation', 'revolutionary', 'cutting-edge', 'next-level',
  'deep dive', 'double down', 'move the needle', 'at the end of the day',
];

function runContentGates(mdxContent) {
  const gates = [];
  const lower = mdxContent.toLowerCase();

  // G8-adjacent: forbidden words check
  const foundForbidden = FORBIDDEN_WORDS.filter(w => lower.includes(w));
  gates.push({
    gate_name: 'forbidden_words',
    passed: foundForbidden.length === 0,
    details: foundForbidden.length > 0
      ? { found: foundForbidden }
      : { checked: FORBIDDEN_WORDS.length },
  });

  // Em dash check
  const hasEmDash = mdxContent.includes('\u2014') || mdxContent.includes('--');
  gates.push({
    gate_name: 'no_em_dashes',
    passed: !hasEmDash,
    details: hasEmDash ? { note: 'Em dashes or -- found' } : {},
  });

  // Contrastive reframe check
  const contrastivePattern = /it'?s not .{1,40},? it'?s /i;
  const hasContrastive = contrastivePattern.test(mdxContent);
  gates.push({
    gate_name: 'no_contrastive_reframes',
    passed: !hasContrastive,
    details: hasContrastive ? { note: '"It\'s not X, it\'s Y" pattern found' } : {},
  });

  // Word count check (minimum 600 for blog posts)
  const wordCount = mdxContent.split(/\s+/).length;
  gates.push({
    gate_name: 'minimum_word_count',
    passed: wordCount >= 600,
    details: { word_count: wordCount, minimum: 600 },
  });

  return gates;
}

// ── PR Delivery ────────────────────────────────────────────────────

async function deliverBlogPR(slug, fullMdx, topic, imageAssets) {
  await requirePermission('executor-writer', 'api_client', 'github_content_write');

  const mdxPath = `content/blog/${slug}.mdx`;
  const files = [{ path: mdxPath, content: fullMdx }];

  // Include generated image in the PR if available
  let imageNote = 'No header image generated.';
  if (imageAssets?.generated && imageAssets.imageBuffer) {
    const ext = (imageAssets.mimeType || 'image/png').split('/')[1] || 'png';
    const imagePath = `public/blog/images/${slug}.${ext}`;
    // GitHub API accepts base64 content for binary files
    files.push({
      path: imagePath,
      content: imageAssets.imageBuffer.toString('base64'),
      encoding: 'base64',
    });
    imageNote = `Header image: \`${imagePath}\``;
  }

  const prResult = await createPR({
    owner: UMB_REPO_OWNER,
    repo: UMB_REPO_NAME,
    baseBranch: 'main',
    branchPrefix: 'blog',
    files,
    commitMessage: `blog: ${topic}`,
    prTitle: `Blog: ${topic}`,
    token: process.env.GITHUB_TOKEN,
    prBody: [
      '## New Blog Post',
      '',
      `**Topic:** ${topic}`,
      `**File:** \`${mdxPath}\``,
      imageNote,
      '',
      'Generated by Optimus executor-writer (Phase 1.5 content engine).',
      '',
      '### Review Checklist',
      '- [ ] Content accuracy verified',
      '- [ ] Tone matches UMB Advisors voice',
      '- [ ] No forbidden words or patterns',
      '- [ ] SEO metadata is appropriate',
      '- [ ] Header image is appropriate',
      '- [ ] Ready to publish',
    ].join('\n'),
    labels: ['blog', 'content-engine'],
    author: { name: 'Eric Gang', email: 'eric@staqs.io' },
    requestReviewers: ['ecgang'],
  });

  return prResult;
}

// ── Store Draft in DB ──────────────────────────────────────────────

async function storeDraft(params) {
  const { topicId, campaignId, workItemId, contentType, title, slug, author,
          body, frontmatter, seoMetadata, imageAssets, gateResults,
          wordCount, readingTimeMin, costUsd, prUrl } = params;

  const result = await query(
    `INSERT INTO content.drafts
       (topic_id, campaign_id, work_item_id, content_type, status, title, slug,
        author, body, frontmatter, seo_metadata, image_assets, gate_results,
        word_count, reading_time_min, cost_usd, published_url)
     VALUES ($1, $2, $3, $4, 'review', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     RETURNING id`,
    [topicId, campaignId, workItemId, contentType, title, slug, author,
     body, JSON.stringify(frontmatter), JSON.stringify(seoMetadata),
     JSON.stringify(imageAssets), JSON.stringify(gateResults),
     wordCount, readingTimeMin, costUsd, prUrl]
  );

  return result.rows[0]?.id;
}

// ── Log Gate Results ───────────────────────────────────────────────

async function logGateResults(draftId, gates) {
  for (const gate of gates) {
    await query(
      `INSERT INTO content.gate_log (draft_id, gate_name, passed, details) VALUES ($1, $2, $3, $4)`,
      [draftId, gate.gate_name, gate.passed, JSON.stringify(gate.details)]
    );
  }
}

// ── Main Handler ───────────────────────────────────────────────────

async function handler(task, context, agent) {
  const metadata = context.workItem?.metadata || {};
  const { topic, content_type = 'blog' } = metadata;

  if (!topic) {
    return { success: false, reason: 'No topic in metadata', costUsd: 0 };
  }

  const campaignId = metadata.campaign_id || null;
  const workItemId = task.work_item_id;
  let totalCost = 0;

  log.info({ topic, content_type, workItemId }, 'Starting content generation');

  // Phase 1: Research
  log.info('Phase 1: Research');
  const { research, costUsd: researchCost } = await phaseResearch(topic, metadata, agent, workItemId);
  totalCost += researchCost;

  // Phase 2: Grounding
  // Worktree 1: thread the work_item owner through phaseGrounding so the
  // RAG retriever's scope gate can run. Prefer explicit metadata.owner_id;
  // fall back to the work_item's creator.
  log.info('Phase 2: Grounding');
  const writerOwnerId = metadata.owner_id || context.workItem?.created_by_member_id || null;
  const { grounding, costUsd: groundingCost } = await phaseGrounding(topic, research, agent, workItemId, writerOwnerId);
  totalCost += groundingCost;

  // Phase 3: Outline + Draft
  log.info('Phase 3: Draft');
  const { mdxContent, draftMeta, costUsd: draftCost } = await phaseDraft(
    topic, metadata, research, grounding, agent, workItemId
  );
  totalCost += draftCost;

  // Phase 4: Image
  log.info('Phase 4: Image');
  const { imageAssets, costUsd: imageCost } = await phaseImage(topic, mdxContent, agent, workItemId);
  totalCost += imageCost;

  // Run content gates
  const gates = runContentGates(mdxContent);
  const allPassed = gates.every(g => g.passed);
  const failedGates = gates.filter(g => !g.passed).map(g => g.gate_name);

  if (!allPassed) {
    log.warn({ failedGates }, 'Content gate failures detected');
  }

  // Build complete MDX file
  const slug = (metadata.slug || topic)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);

  const frontmatter = buildFrontmatter(topic, metadata, draftMeta, imageAssets, totalCost, campaignId, workItemId);
  const fullMdx = `${frontmatter}\n\n${mdxContent}\n`;

  // Deliver as PR (blog only)
  let prUrl = null;
  if (content_type === 'blog') {
    try {
      const prResult = await deliverBlogPR(slug, fullMdx, topic, imageAssets);
      prUrl = prResult.prUrl;
      log.info({ prUrl, prNumber: prResult.prNumber }, 'Blog PR created');
    } catch (err) {
      log.error({ err }, 'Failed to create blog PR — draft stored in DB');
    }
  }

  // Store draft in content.drafts
  const wordCount = mdxContent.split(/\s+/).length;
  const readingTimeMin = Math.ceil(wordCount / 250);

  let draftId;
  try {
    draftId = await storeDraft({
      topicId: metadata.topic_id || null,
      campaignId,
      workItemId,
      contentType: content_type,
      title: draftMeta.seo_title || topic,
      slug,
      author: metadata.author || 'UMB Advisors',
      body: mdxContent,
      frontmatter: { raw: frontmatter },
      seoMetadata: {
        title: draftMeta.seo_title,
        description: draftMeta.seo_description,
        keywords: draftMeta.seo_keywords,
      },
      imageAssets,
      gateResults: gates,
      wordCount,
      readingTimeMin,
      costUsd: totalCost,
      prUrl,
    });

    // Log gate results
    if (draftId) {
      await logGateResults(draftId, gates);
    }
  } catch (err) {
    log.error({ err }, 'Failed to store draft in DB');
  }

  // Store result in work_item metadata for campaign access
  const contentResult = {
    draft_id: draftId,
    slug,
    content_type,
    word_count: wordCount,
    reading_time_min: readingTimeMin,
    gates_passed: allPassed,
    failed_gates: failedGates,
    pr_url: prUrl,
    cost_usd: totalCost,
    phases: {
      research: { cost: researchCost },
      grounding: { cost: groundingCost },
      draft: { cost: draftCost },
      image: { cost: imageCost },
    },
  };

  await query(
    `UPDATE agent_graph.work_items SET metadata = metadata || $1 WHERE id = $2`,
    [JSON.stringify({ content_result: contentResult }), workItemId]
  );

  // Enqueue content-atomizer to generate LinkedIn posts from this blog
  if (content_type === 'blog' && draftId) {
    try {
      const atomizerMeta = {
        source_draft_id: draftId,
        linkedin_count: metadata.linkedin_count || 2,
        blog_url: prUrl || `https://umbadvisors.com/blog/${slug}`,
        topic,
        campaign_id: campaignId,
      };
      const { rows: [atomizerWork] } = await query(
        `INSERT INTO agent_graph.work_items
           (type, title, status, assigned_to, priority, created_by, metadata)
         VALUES ('task', $2, 'assigned', 'content-atomizer', 5, 'executor-writer', $1)
         RETURNING id`,
        [JSON.stringify(atomizerMeta), 'Atomize: ' + (topic || '').slice(0, 80)]
      );
      if (atomizerWork?.id) {
        await query(
          `INSERT INTO agent_graph.task_events (event_type, work_item_id, target_agent_id, priority, event_data)
           VALUES ('task_assigned', $1, 'content-atomizer', 5, $2)`,
          [atomizerWork.id, JSON.stringify({ campaign_id: campaignId, source_draft_id: draftId })]
        );
        await query(`SELECT pg_notify('agent_wake', $1)`, [JSON.stringify({
          agent: 'content-atomizer', work_item_id: atomizerWork.id,
        })]);
        log.info({ atomizerWorkId: atomizerWork.id, draftId }, 'Content-atomizer enqueued for LinkedIn posts');
      }
    } catch (err) {
      log.warn({ err }, 'Failed to enqueue content-atomizer — blog stored but LinkedIn posts not scheduled');
    }
  }

  const summary = [
    `Content generated: "${topic}" (${wordCount} words, ${readingTimeMin} min read)`,
    allPassed ? 'All gates passed.' : `Gate failures: ${failedGates.join(', ')}`,
    prUrl ? `PR: ${prUrl}` : 'No PR created (non-blog or error).',
    `Total cost: $${totalCost.toFixed(4)}`,
  ].join(' ');

  return { success: true, reason: summary, costUsd: totalCost };
}

export const writerLoop = new AgentLoop('executor-writer', handler);
