-- Speed up the "LinkedIn account" filter distinct-scans and equality filters.
CREATE INDEX IF NOT EXISTS "connection_requests_actor_linkedin_id_idx" ON "connection_requests" ("actor_linkedin_id");
CREATE INDEX IF NOT EXISTS "message_activity_self_linkedin_id_idx" ON "message_activity" ("self_linkedin_id");
