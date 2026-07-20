-- Indexes to keep the public list/sort endpoints off full table scans.
CREATE INDEX "connection_requests_sent_at_idx" ON "connection_requests"("sent_at");
CREATE INDEX "connection_requests_user_id_sent_at_idx" ON "connection_requests"("user_id", "sent_at");
CREATE INDEX "message_activity_last_message_at_idx" ON "message_activity"("last_message_at");
CREATE INDEX "message_activity_user_id_last_message_at_idx" ON "message_activity"("user_id", "last_message_at");
