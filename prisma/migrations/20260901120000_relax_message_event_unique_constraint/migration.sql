-- DropIndex
DROP INDEX "message_events_user_id_conversation_key_message_id_key";

-- CreateIndex
CREATE UNIQUE INDEX "message_events_conversation_key_message_id_key" ON "message_events"("conversation_key", "message_id");
