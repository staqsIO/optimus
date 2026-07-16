// Re-export shim — real implementation in lib/adapters/registry.js
export {
  registerAdapter,
  getAdapter,
  getAdapterForMessage,
  clearAdapters,
  setSignalEmitter,
  clearSignalEmitter,
  emitAdapterSignal,
} from '../../../lib/adapters/registry.js';
