-- CreateEnum
CREATE TYPE "ConnectionEventSource" AS ENUM ('INTERCEPT', 'RECONCILE', 'BACKFILL');

-- AlterTable
-- sent_at_is_estimate: sentAt was inferred from LinkedIn's relative "Sent 3
-- weeks ago" text during backfill rather than observed at send time.
-- absent_since: first COMPLETE sent-list walk in which a pending row was missing
-- from LinkedIn's list. Absence must be confirmed twice before writing a
-- terminal status, because offset pagination over a mutating list can skip an
-- entry and a skipped entry looks identical to a resolved one.
ALTER TABLE "connection_requests"
    ADD COLUMN "sent_at_is_estimate" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "absent_since" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "connection_requests_user_id_status_idx" ON "connection_requests"("user_id", "status");

-- CreateIndex
CREATE INDEX "connection_requests_user_id_actor_linkedin_id_status_idx" ON "connection_requests"("user_id", "actor_linkedin_id", "status");

-- CreateTable
CREATE TABLE "connection_request_events" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "target_linkedin_id" TEXT NOT NULL,
    "target_name" TEXT,
    "target_profile_url" TEXT,
    "actor_linkedin_id" TEXT,
    "from_status" "ConnectionRequestStatus",
    "to_status" "ConnectionRequestStatus" NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "occurred_at_is_estimate" BOOLEAN NOT NULL DEFAULT false,
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" "ConnectionEventSource" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connection_request_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "connection_request_events_user_id_occurred_at_idx" ON "connection_request_events"("user_id", "occurred_at");

-- CreateIndex
CREATE INDEX "connection_request_events_actor_linkedin_id_occurred_at_idx" ON "connection_request_events"("actor_linkedin_id", "occurred_at");

-- CreateIndex
CREATE INDEX "connection_request_events_to_status_occurred_at_idx" ON "connection_request_events"("to_status", "occurred_at");

-- CreateIndex
CREATE INDEX "connection_request_events_user_id_to_status_occurred_at_idx" ON "connection_request_events"("user_id", "to_status", "occurred_at");

-- CreateIndex
CREATE INDEX "connection_request_events_user_id_target_linkedin_id_idx" ON "connection_request_events"("user_id", "target_linkedin_id");

-- AddForeignKey
ALTER TABLE "connection_request_events" ADD CONSTRAINT "connection_request_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
