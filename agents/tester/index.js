import { AgentLoop } from '../../lib/runtime/agent-loop.js';
import { testerHandler } from './handler.js';

// The handler logic lives in ./handler.js so it can be unit-tested without
// importing the full agent-loop dependency chain. This file only wires it into
// a first-class AgentLoop.
export const testerLoop = new AgentLoop('tester', testerHandler);
export { testerHandler, parseVerdict } from './handler.js';
