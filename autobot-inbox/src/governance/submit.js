import { query } from '../db.js';
import { publishEvent } from '../runtime/infrastructure.js';

/**
 * Submit a governance proposal from an agent.
 * Used by strategist/architect agents to propose spec amendments,
 * ADRs, process improvements, or new agent configurations.
 *
 * The submission flows through the same intake pipeline as board
 * submissions — classification + audit before board review.
 *
 * @param {Object} options
 * @param {string} options.title — short title for the proposal
 * @param {string} options.contentType — spec_amendment, agent_proposal, adr, process_improvement, research
 * @param {string} options.rawContent — markdown body of the proposal
 * @param {string} options.submittedBy — agent ID (e.g. 'strategist', 'architect')
 * @param {string} [options.workItemId] — originating work item if applicable
 * @param {string[]} [options.specDomains] — pre-classified domains if known
 * @param {string[]} [options.affectedAdrs] — pre-classified ADRs if known
 * @returns {Promise<{id: string, title: string, status: string}>}
 */
export async function submitGovernanceProposal({
  title,
  contentType,
  rawContent,
  submittedBy,
  workItemId = null,
  specDomains = [],
  affectedAdrs = [],
}) {
  // Validate content type
  const validTypes = [
    'spec_amendment', 'agent_proposal', 'research', 'idea',
    'adr', 'process_improvement', 'external_reference',
  ];
  if (!validTypes.includes(contentType)) {
    throw new Error(`Invalid contentType: ${contentType}`);
  }

  if (rawContent && rawContent.length > 100_000) {
    throw new Error('rawContent too large (max 100,000 characters)');
  }

  const result = await query(
    `INSERT INTO agent_graph.governance_submissions
     (title, content_type, source_format, raw_content, submitted_by, work_item_id, spec_domains, affected_adrs)
     VALUES ($1, $2, 'markdown', $3, $4, $5, $6, $7)
     RETURNING id, title, status, created_at`,
    [title, contentType, rawContent, submittedBy, workItemId, specDomains, affectedAdrs]
  );

  const submission = result.rows[0];

  await publishEvent(
    'governance_submission',
    `Agent submission: ${title} (by ${submittedBy})`,
    submittedBy,
    submission.id,
    { content_type: contentType, submitted_by: submittedBy, agent_originated: true },
  );

  console.log(`[governance] agent submission ${submission.id}: "${title}" by ${submittedBy}`);

  // Trigger async classification (import dynamically to avoid circular deps)
  try {
    const { triggerClassification } = await import('../api-routes/governance.js');
    triggerClassification(submission.id).catch(err => {
      console.warn(`[governance] async classification failed for ${submission.id}:`, err.message);
    });
  } catch {
    // Classification will happen on next fetch if trigger fails
  }

  return submission;
}
