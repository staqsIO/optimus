// Re-export shim — real implementation in lib/runtime/state-machine.js
export {
  transitionState, claimNextTask, claimAndStart, createWorkItem,
  createEdge
} from '../../../lib/runtime/state-machine.js';
