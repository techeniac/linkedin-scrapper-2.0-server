-- CreateTable
CREATE TABLE "message_activity" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "conversation_key" TEXT NOT NULL,
    "participant_linkedin_id" TEXT,
    "participant_name" TEXT,
    "sent_count" INTEGER NOT NULL DEFAULT 0,
    "received_count" INTEGER NOT NULL DEFAULT 0,
    "follow_up_count" INTEGER NOT NULL DEFAULT 0,
    "read_count" INTEGER NOT NULL DEFAULT 0,
    "has_reply" BOOLEAN NOT NULL DEFAULT false,
    "is_conversation" BOOLEAN NOT NULL DEFAULT false,
    "first_message_at" TIMESTAMP(3),
    "last_message_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "message_activity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "message_activity_user_id_idx" ON "message_activity"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "message_activity_user_id_conversation_key_key" ON "message_activity"("user_id", "conversation_key");

-- AddForeignKey
ALTER TABLE "message_activity" ADD CONSTRAINT "message_activity_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
