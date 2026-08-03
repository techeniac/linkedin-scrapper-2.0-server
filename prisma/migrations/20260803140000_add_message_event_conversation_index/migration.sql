-- CreateIndex
-- Powers the Missed Follow-Up report's "last event per conversation" query:
-- DISTINCT ON (user_id, conversation_key) ... ORDER BY user_id, conversation_key, occurred_at DESC
CREATE INDEX "message_events_user_id_conversation_key_occurred_at_idx" ON "message_events"("user_id", "conversation_key", "occurred_at");
