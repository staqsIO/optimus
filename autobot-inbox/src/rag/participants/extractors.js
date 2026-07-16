// Re-export shim — real implementation in lib/rag/participants/extractors.js
export {
  parseAddressHeader,
  splitAddressList,
  extractFromTldvSegments,
  extractFromTldvMeeting,
  extractFromEmailThread,
  extractFromEmailParticipantStrings,
  extractFromDriveFile,
  extractParticipants,
} from '../../../../lib/rag/participants/extractors.js';
