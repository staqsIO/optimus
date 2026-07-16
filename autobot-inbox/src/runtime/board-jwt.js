// Re-export shim — real implementation in lib/runtime/board-jwt.js
export {
  initializeBoardJwtKeys, issueBoardToken, verifyBoardToken, revokeBoardToken,
  pruneRevokedTokens
} from '../../../lib/runtime/board-jwt.js';
