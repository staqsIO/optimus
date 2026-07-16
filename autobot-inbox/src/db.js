// Re-export shim — real implementation in lib/db.js
export {
  initializeDatabase, query, withTransaction, setAgentContext,
  withAgentScope, withBoardScope, withSystemOrgScope,
  sha256, getMode, getPool,
  close,
  _getPgLiteForTest,
} from '../../lib/db.js';
