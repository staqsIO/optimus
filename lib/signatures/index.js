/**
 * Signatures module — self-built e-signature system.
 * ESIGN Act + UETA compliant. Hash-chained audit trail.
 */

export {
  createSigningRequest,
  getRequest,
  listRequests,
  revokeRequest,
  getSignerByToken,
  getDocumentBody,
} from './session.js';

export {
  validateToken,
  recordView,
  executeSign,
  executeDecline,
  CONSENT_TEXT,
} from './signer.js';

export {
  sendSigningEmail,
  sendSigningReminder,
  sendSignedConfirmation,
  sendRequestCompletedToBoard,
  sendProposalReplyEmail,
} from './notifier.js';
