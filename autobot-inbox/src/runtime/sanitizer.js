// Re-export shim — real implementation in lib/runtime/sanitizer.js
export {
  initSanitizer, sanitize, countInjectionAttempts, detectAndRecordThreats,
  detectPII, checkModelArmor, getActiveRuleSetVersion, computeRuleSetHash,
  proposeNewRuleSet, activateRuleSet, getRuleSet, listRuleSets,
  sanitizeWithRules
} from '../../../lib/runtime/sanitizer.js';
