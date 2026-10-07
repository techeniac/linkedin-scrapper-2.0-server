-- AlterTable
ALTER TABLE "message_events" ADD COLUMN     "attribution_source" TEXT,
ADD COLUMN     "resolved_owner_id" TEXT;

-- CreateTable
CREATE TABLE "conversation_owner_cache" (
    "conversation_key" TEXT NOT NULL,
    "resolved_owner_id" TEXT,
    "attribution_source" TEXT NOT NULL,
    "resolved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_owner_cache_pkey" PRIMARY KEY ("conversation_key")
);

-- AddForeignKey
ALTER TABLE "message_events" ADD CONSTRAINT "message_events_resolved_owner_id_fkey" FOREIGN KEY ("resolved_owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_owner_cache" ADD CONSTRAINT "conversation_owner_cache_resolved_owner_id_fkey" FOREIGN KEY ("resolved_owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
