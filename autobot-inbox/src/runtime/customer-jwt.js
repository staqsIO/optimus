// Re-export shim — real implementation in lib/runtime/agents/customer-jwt.js
export {
  initializeCustomerJwtKeys, issueCustomerToken, verifyCustomerToken, revokeCustomerToken
} from '../../../lib/runtime/agents/customer-jwt.js';
