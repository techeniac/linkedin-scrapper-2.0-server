-- AlterTable
-- responds_to_at: the immediately preceding message's occurredAt in this
--   conversation (either side) — what this message is a response to. Powers
--   the Late Messages / Missed Follow-Up reports' deadline computation.
-- self_time_zone: the rep's IANA timezone at record time (browser-sourced,
--   same pattern as the existing client-supplied userTimeZone elsewhere).
ALTER TABLE "message_events"
    ADD COLUMN "responds_to_at" TIMESTAMP(3),
    ADD COLUMN "self_time_zone" TEXT;
