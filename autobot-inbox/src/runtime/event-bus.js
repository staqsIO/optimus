// Re-export shim — real implementation in lib/runtime/event-bus.js
export {
  initPgNotify, subscribe, onAnyEvent, emit,
  notify, emitHalt, clearHalt, isHalted,
  invalidateHaltCache, unsubscribeAll
} from '../../../lib/runtime/event-bus.js';
