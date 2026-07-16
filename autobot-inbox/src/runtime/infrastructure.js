// Re-export shim — real implementation in lib/runtime/infrastructure.js
export {
  publishEvent, runReconciliation, createHashCheckpoint, verifyToolRegistry,
  startActivityStep, completeActivityStep, logCommsIntent
} from '../../../lib/runtime/infrastructure.js';
