-- AlterTable: record the LinkedIn account (actor B) that sent each request,
-- separate from the extension/app user (A) already stored in user_id.
ALTER TABLE "connection_requests" ADD COLUMN "actor_linkedin_id" TEXT;
ALTER TABLE "connection_requests" ADD COLUMN "actor_name" TEXT;
ALTER TABLE "connection_requests" ADD COLUMN "actor_public_identifier" TEXT;
