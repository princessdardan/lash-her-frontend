-- Migration 0016 was applied to staging from an earlier file revision that
-- omitted these uniqueness guarantees. Recreate the schema declared by the
-- current Drizzle model without rewriting historical migration records.
CREATE UNIQUE INDEX IF NOT EXISTS "marketing_contact_sync_jobs_submission_id_idx"
	ON "public"."marketing_contact_sync_jobs" USING btree ("submission_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "marketing_contact_sync_jobs_consent_event_id_idx"
	ON "public"."marketing_contact_sync_jobs" USING btree ("consent_event_id");
