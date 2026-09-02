-- CreateIndex
CREATE INDEX "message_events_effective_owner_occurred_at_idx"
  ON "message_events" ((COALESCE(resolved_owner_id, user_id)), occurred_at);

-- CreateIndex
CREATE INDEX "message_events_effective_owner_conv_occurred_at_idx"
  ON "message_events" ((COALESCE(resolved_owner_id, user_id)), conversation_key, occurred_at DESC);
