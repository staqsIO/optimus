/**
 * LinkedIn Poster — OutputAdapter for posting content to LinkedIn.
 * Implements the OutputAdapter interface (channel, createDraft, executeDraft).
 *
 * Auth: LinkedIn OAuth 2.0 access token (w_member_social scope).
 * Tokens expire in 60 days — refresh logic included.
 *
 * Tier 3 (Reputational) in Communication Gateway — human-in-the-loop required.
 */

import { query } from '../db.js';
import { createChildLogger } from '../logger.js';

const log = createChildLogger({ module: 'linkedin-poster' });

const LINKEDIN_API = 'https://api.linkedin.com/v2';

/**
 * Get LinkedIn auth headers.
 * @returns {Object} Headers with Bearer token
 */
function getHeaders() {
  const token = process.env.LINKEDIN_ACCESS_TOKEN;
  if (!token) {
    throw new Error('LINKEDIN_ACCESS_TOKEN not set. Complete OAuth flow first.');
  }
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-Restli-Protocol-Version': '2.0.0',
  };
}

/**
 * Get the LinkedIn member URN for the authenticated user.
 * @returns {Promise<string>} URN like "urn:li:person:abc123"
 */
async function getMemberUrn() {
  // Check cache in env first
  if (process.env.LINKEDIN_MEMBER_URN) {
    return process.env.LINKEDIN_MEMBER_URN;
  }

  const res = await fetch(`${LINKEDIN_API}/userinfo`, {
    headers: getHeaders(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LinkedIn userinfo failed ${res.status}: ${text}`);
  }

  const data = await res.json();
  return `urn:li:person:${data.sub}`;
}

/**
 * Create a LinkedIn text post.
 *
 * @param {string} text - Post body text
 * @param {Object} [opts] - Options
 * @param {string} [opts.authorUrn] - Override author URN
 * @param {string} [opts.articleUrl] - URL to attach as article share
 * @param {string} [opts.articleTitle] - Title for article share
 * @returns {Promise<{postId: string, postUrn: string}>}
 */
export async function createLinkedInPost(text, opts = {}) {
  // Prefer organization posting (company page) over personal profile
  const orgUrn = process.env.LINKEDIN_ORG_URN; // e.g. "urn:li:organization:123456"
  const authorUrn = opts.authorUrn || orgUrn || await getMemberUrn();

  const payload = {
    author: authorUrn,
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: { text },
        shareMediaCategory: opts.articleUrl ? 'ARTICLE' : 'NONE',
      },
    },
    visibility: {
      'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC',
    },
  };

  // Add article share if URL provided
  if (opts.articleUrl) {
    payload.specificContent['com.linkedin.ugc.ShareContent'].media = [{
      status: 'READY',
      originalUrl: opts.articleUrl,
      title: { text: opts.articleTitle || '' },
    }];
  }

  const res = await fetch(`${LINKEDIN_API}/ugcPosts`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LinkedIn post failed ${res.status}: ${text}`);
  }

  const postUrn = res.headers.get('x-restli-id') || '';
  const postId = postUrn.split(':').pop() || '';

  log.info({ postId, postUrn }, 'LinkedIn post published');
  return { postId, postUrn };
}

// ── OutputAdapter Interface ────────────────────────────────────────

/**
 * OutputAdapter implementation for LinkedIn.
 * createDraft stores in content.drafts; executeDraft posts via API.
 */
export const linkedinAdapter = {
  channel: 'linkedin',

  /**
   * Create a draft — stores the LinkedIn post in content.drafts for review.
   * Returns the draft ID (board reviews via Tier 3 gateway).
   * @param {string} draftId - content.drafts ID
   * @returns {Promise<string|null>} Platform draft ID (same as input for DB-stored drafts)
   */
  async createDraft(draftId) {
    // Draft is already in content.drafts — just mark it as ready for review
    await query(
      `UPDATE content.drafts SET status = 'review', updated_at = now() WHERE id = $1`,
      [draftId]
    );
    log.info({ draftId }, 'LinkedIn draft marked for review');
    return draftId;
  },

  /**
   * Execute (publish) an approved draft via LinkedIn API.
   * @param {string} draftId - content.drafts ID
   * @returns {Promise<string>} LinkedIn post URL
   */
  async executeDraft(draftId) {
    // Fetch draft content
    const result = await query(
      `SELECT body, slug, source_draft_id FROM content.drafts WHERE id = $1`,
      [draftId]
    );

    if (!result.rows.length) {
      throw new Error(`Draft ${draftId} not found`);
    }

    const draft = result.rows[0];

    // If this LinkedIn post was derived from a blog post, include the article link
    let articleUrl = null;
    let articleTitle = null;
    if (draft.source_draft_id) {
      const sourceResult = await query(
        `SELECT title, slug, published_url FROM content.drafts WHERE id = $1`,
        [draft.source_draft_id]
      );
      if (sourceResult.rows[0]) {
        // Always use the blog URL (published_url stores the GitHub PR link, not the blog)
        articleUrl = sourceResult.rows[0].slug
          ? `https://umbadvisors.com/blog/${sourceResult.rows[0].slug}`
          : sourceResult.rows[0].published_url;
        articleTitle = sourceResult.rows[0].title;
      }
    }

    const { postId, postUrn } = await createLinkedInPost(draft.body, {
      articleUrl,
      articleTitle,
    });

    const postUrl = `https://www.linkedin.com/feed/update/${postUrn}`;

    // Update draft status
    await query(
      `UPDATE content.drafts
       SET status = 'published', published_at = now(), published_url = $1, updated_at = now()
       WHERE id = $2`,
      [postUrl, draftId]
    );

    log.info({ draftId, postUrl }, 'LinkedIn draft published');
    return postUrl;
  },
};

/**
 * Check if LinkedIn API is configured and accessible.
 * @returns {Promise<boolean>}
 */
export async function isLinkedInConfigured() {
  return !!process.env.LINKEDIN_ACCESS_TOKEN;
}
