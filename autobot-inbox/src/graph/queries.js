// Re-export shim — real implementation in lib/graph/queries.js
export {
  getDecisionOutcomeChain, getDelegationEffectiveness, getAgentCapabilityUtilization, getSimilarOutcomePatterns,
  getOrganizationalTopology, formatLearningContext, getTaskRelevantContext, formatTaskContext
} from '../../../lib/graph/queries.js';
