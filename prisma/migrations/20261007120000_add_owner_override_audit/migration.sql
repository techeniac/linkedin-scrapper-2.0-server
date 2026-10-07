-- CreateTable
CREATE TABLE "owner_override_audit" (
    "id" TEXT NOT NULL,
    "conversation_key" TEXT NOT NULL,
    "old_owner_id" TEXT,
    "new_owner_id" TEXT NOT NULL,
    "performed_by_email" TEXT NOT NULL,
    "performed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "owner_override_audit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "owner_override_audit_conversation_key_idx" ON "owner_override_audit"("conversation_key");
