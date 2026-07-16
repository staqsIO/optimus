// Re-export shim — real implementation in lib/runtime/phase-manager.js
export {
  getCurrentPhase, activatePhase, getPhaseConfig, isPhase3Active,
  isPhase4Active
} from '../../../lib/runtime/phase-manager.js';
