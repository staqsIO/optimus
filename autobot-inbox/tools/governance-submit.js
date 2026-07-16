/**
 * MCP-compatible tool definition for governance submissions.
 * Available to strategist and architect tier agents.
 */
export const definition = {
  name: 'governance_submit',
  description: 'Submit a governance proposal for board review. Use this to propose spec amendments, new agent configurations, process improvements, or ADRs. The submission will be automatically audited against the constitution and architecture before board review.',
  input_schema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Short title for the proposal (max 200 chars)',
      },
      content_type: {
        type: 'string',
        enum: ['spec_amendment', 'agent_proposal', 'adr', 'process_improvement', 'research', 'idea', 'external_reference'],
        description: 'Type of governance submission',
      },
      content: {
        type: 'string',
        description: 'Full markdown body of the proposal',
      },
      affected_adrs: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of ADRs this proposal affects (e.g. ["ADR-009", "ADR-010"])',
      },
      spec_domains: {
        type: 'array',
        items: { type: 'string' },
        description: 'Affected domains (e.g. ["agent_graph", "voice"])',
      },
    },
    required: ['title', 'content_type', 'content'],
  },
};

export async function execute({ title, content_type, content, affected_adrs, spec_domains }, context) {
  const { submitGovernanceProposal } = await import('../src/governance/submit.js');

  const result = await submitGovernanceProposal({
    title,
    contentType: content_type,
    rawContent: content,
    submittedBy: context?.agentId || 'agent',
    workItemId: context?.workItemId || null,
    specDomains: spec_domains || [],
    affectedAdrs: affected_adrs || [],
  });

  return {
    success: true,
    submission_id: result.id,
    message: `Governance submission "${title}" created (${result.id}). It will be automatically audited and queued for board review.`,
  };
}
