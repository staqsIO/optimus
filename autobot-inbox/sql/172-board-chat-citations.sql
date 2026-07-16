-- 172-board-chat-citations.sql
-- OQ-4 (feature 010-B): persist chat provenance citations on the assistant
-- message row for audit (P3 transparency by structure). Previously citations
-- (RAG + the new `graph` chips from query_graph) were returned in the response
-- only — ephemeral, lost on reload and invisible to audit. This column carries
-- the full set written at turn finalize.
--
-- Shape: jsonb array of { n, kind, label, snippet, documentId?, similarity? }.
-- Nullable: most turns produce no citations, and history rows predating this
-- migration stay NULL (rendered as no chips, exactly as today).

ALTER TABLE agent_graph.board_chat_messages
  ADD COLUMN IF NOT EXISTS citations jsonb;

COMMENT ON COLUMN agent_graph.board_chat_messages.citations IS
  'Provenance chips (RAG + graph) for an assistant turn; jsonb array of {n,kind,label,snippet,...}. NULL = none. (OQ-4)';
