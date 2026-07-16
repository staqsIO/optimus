import { query } from '../../lib/db.js';
import { AgentLoop } from '../../lib/runtime/agent-loop.js';
import { createChildLogger } from '../../lib/logger.js';

const log = createChildLogger({ agent: 'content-atomizer' });

/**
 * Content Atomizer: derives LinkedIn posts from blog post drafts.
 *
 * Takes a blog draft (from content.drafts) and generates 1-3 LinkedIn-sized
 * posts that link back to the full article. Uses Dustin's voice guide for
 * tone matching on LinkedIn content.
 *
 * Input metadata:
 *   - source_draft_id: UUID — the blog draft to atomize
 *   - author: string — voice profile to use (default: Dustin's guide)
 *   - linkedin_count: number — how many LinkedIn posts to derive (default: 2)
 *   - blog_url: string — URL of the published blog post (for linking)
 *
 * Output: creates LinkedIn drafts in content.drafts with source_draft_id set.
 */

const ATOMIZER_PROMPT = `You are a LinkedIn content writer for UMB Advisors. Your job is to take a long-form blog post and extract the most compelling angles into short-form LinkedIn posts.

Voice guidelines (for LinkedIn specifically):
- Calm experienced operator, thinking in public not performing
- Speaking to peers not an audience
- Grounded in operational reality
- Occasionally playful, never motivational
- Opening with a grounded observation, not a hook
- Quiet closing line, not a CTA

Hard constraints:
- No em dashes
- No "It's not X, it's Y" constructions
- No bullet points (unless listing concrete data)
- No motivational/hype language
- Forbidden words: "game changer", "unlock", "journey", "leverage", "disrupt", "synergy", "empower", "transformation", "revolutionary", "cutting-edge", "next-level", "deep dive", "double down", "move the needle", "at the end of the day"
- Minimal formatting (no bold, no headers, no numbered lists)
- Each post should be 150-300 words
- Structure: grounded opening observation, operational insight with economics, implication for operators, quiet closing line

Output valid JSON (no markdown fences):
{
  "posts": [
    {
      "body": "The full LinkedIn post text",
      "angle": "Which angle from the blog this covers",
      "hook_line": "The opening line (for preview)"
    }
  ]
}`;

async function handler(task, context, agent) {
  const metadata = context.workItem?.metadata || {};
  const { source_draft_id, linkedin_count = 2, blog_url } = metadata;

  if (!source_draft_id) {
    return { success: false, reason: 'No source_draft_id in metadata', costUsd: 0 };
  }

  // Fetch the source blog draft
  const draftResult = await query(
    `SELECT id, title, body, author, slug FROM content.drafts WHERE id = $1`,
    [source_draft_id]
  );

  if (!draftResult.rows.length) {
    return { success: false, reason: `Draft ${source_draft_id} not found`, costUsd: 0 };
  }

  const draft = draftResult.rows[0];
  const postUrl = blog_url || `https://umbadvisors.com/blog/${draft.slug}`;

  log.info({ source_draft_id, title: draft.title, linkedin_count }, 'Atomizing blog post');

  const userMsg = `Blog post title: "${draft.title}"
Author: ${draft.author}
Blog URL: ${postUrl}
Number of LinkedIn posts to generate: ${linkedin_count}

Blog post content:
${draft.body}

Generate ${linkedin_count} LinkedIn posts. Each should cover a different angle from the blog post. Include "Read the full piece: ${postUrl}" as a natural closing element (not a CTA — weave it in).`;

  const response = await agent.callLLM(ATOMIZER_PROMPT, userMsg, {
    taskId: task.work_item_id,
    maxTokens: 4096,
    temperature: 0.5,
  });

  let parsed;
  try {
    // Strip markdown fences if LLM wraps output in ```json ... ```
    let jsonText = response.text.trim();
    const fenceMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonText = fenceMatch[1].trim();
    parsed = JSON.parse(jsonText);
  } catch (parseErr) {
    log.error({ raw: response.text?.slice(0, 500), err: parseErr.message }, 'Failed to parse atomizer LLM output');
    return {
      success: false,
      reason: `Failed to parse atomizer LLM output: ${parseErr.message}`,
      costUsd: response.costUsd,
    };
  }

  const posts = parsed.posts || [];
  const linkedinDraftIds = [];

  // Store each LinkedIn post as a draft
  for (const post of posts) {
    const result = await query(
      `INSERT INTO content.drafts
         (campaign_id, work_item_id, content_type, status, title, author,
          body, source_draft_id, word_count, cost_usd)
       VALUES ($1, $2, 'linkedin', 'review', $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        metadata.campaign_id || null,
        task.work_item_id,
        `LinkedIn: ${post.angle}`,
        draft.author,
        post.body,
        source_draft_id,
        post.body.split(/\s+/).length,
        response.costUsd / posts.length,
      ]
    );

    if (result.rows[0]) {
      linkedinDraftIds.push(result.rows[0].id);
    }
  }

  // Store results in work_item metadata
  const atomizeResult = {
    source_draft_id,
    linkedin_draft_ids: linkedinDraftIds,
    post_count: posts.length,
    cost_usd: response.costUsd,
  };

  await query(
    `UPDATE agent_graph.work_items SET metadata = metadata || $1 WHERE id = $2`,
    [JSON.stringify({ atomize_result: atomizeResult }), task.work_item_id]
  );

  return {
    success: true,
    reason: `Atomized "${draft.title}" into ${posts.length} LinkedIn post(s). Draft IDs: ${linkedinDraftIds.join(', ')}`,
    costUsd: response.costUsd,
  };
}

export const atomizerLoop = new AgentLoop('content-atomizer', handler);
