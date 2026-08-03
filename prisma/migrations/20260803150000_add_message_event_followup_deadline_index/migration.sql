-- CreateIndex
-- Powers the Missed Follow-Up report's stable chart series: finding resolved-
-- late follow-up crossings bounded by responds_to_at (the trigger message),
-- not occurred_at (the eventual, possibly much-later resolution).
CREATE INDEX "message_events_user_id_is_follow_up_responds_to_at_idx" ON "message_events"("user_id", "is_follow_up", "responds_to_at");
