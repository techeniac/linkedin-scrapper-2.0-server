-- AlterTable
ALTER TABLE "conversation_owner_cache" ADD COLUMN "ambiguous_reason" TEXT;

-- AlterTable
ALTER TABLE "owner_override_audit"
ADD COLUMN "ambiguous_reason" TEXT,
ADD COLUMN "old_participant_name" TEXT,
ADD COLUMN "new_participant_name" TEXT;
