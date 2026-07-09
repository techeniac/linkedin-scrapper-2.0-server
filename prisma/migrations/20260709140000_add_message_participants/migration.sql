-- Store both identities on each conversation: the participant (receiver) and
-- the app user's own LinkedIn identity (sender), each with a profile URL.
ALTER TABLE "message_activity"
  ADD COLUMN "participant_profile_url" TEXT,
  ADD COLUMN "self_linkedin_id" TEXT,
  ADD COLUMN "self_name" TEXT,
  ADD COLUMN "self_profile_url" TEXT;
