-- CreateEnum
CREATE TYPE "MessageEventType" AS ENUM ('SENT', 'RECEIVED');

-- CreateTable
CREATE TABLE "message_events" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "conversation_key" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "type" "MessageEventType" NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "is_first_touch" BOOLEAN NOT NULL DEFAULT false,
    "is_follow_up" BOOLEAN NOT NULL DEFAULT false,
    "is_first_reply" BOOLEAN NOT NULL DEFAULT false,
    "participant_linkedin_id" TEXT,
    "self_linkedin_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "message_events_user_id_conversation_key_message_id_key" ON "message_events"("user_id", "conversation_key", "message_id");

-- CreateIndex
CREATE INDEX "message_events_user_id_occurred_at_idx" ON "message_events"("user_id", "occurred_at");

-- CreateIndex
CREATE INDEX "message_events_type_occurred_at_idx" ON "message_events"("type", "occurred_at");

-- CreateIndex
CREATE INDEX "message_events_user_id_type_occurred_at_idx" ON "message_events"("user_id", "type", "occurred_at");

-- AddForeignKey
ALTER TABLE "message_events" ADD CONSTRAINT "message_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
