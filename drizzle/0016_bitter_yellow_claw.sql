CREATE TYPE "public"."marketing_contact_sync_job_status" AS ENUM('queued', 'processing', 'succeeded', 'retryable_failed', 'dead_letter', 'skipped_unconfigured');--> statement-breakpoint
CREATE TABLE "marketing_contact_sync_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text NOT NULL,
	"contact_id" uuid,
	"submission_id" uuid,
	"consent_event_id" uuid,
	"email" text NOT NULL,
	"email_normalized" text NOT NULL,
	"source" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "marketing_contact_sync_job_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_by" text,
	"locked_until" timestamp with time zone,
	"last_attempted_at" timestamp with time zone,
	"last_error" text,
	"last_error_context" jsonb,
	"succeeded_at" timestamp with time zone,
	"skipped_at" timestamp with time zone,
	"dead_lettered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketing_contact_sync_jobs_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "marketing_contact_sync_jobs" ADD CONSTRAINT "marketing_contact_sync_jobs_contact_id_marketing_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."marketing_contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_contact_sync_jobs" ADD CONSTRAINT "marketing_contact_sync_jobs_submission_id_marketing_contact_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."marketing_contact_submissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_contact_sync_jobs" ADD CONSTRAINT "marketing_contact_sync_jobs_consent_event_id_marketing_consent_events_id_fk" FOREIGN KEY ("consent_event_id") REFERENCES "public"."marketing_consent_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "marketing_contact_sync_jobs_status_next_run_at_idx" ON "marketing_contact_sync_jobs" USING btree ("status","next_run_at");--> statement-breakpoint
CREATE INDEX "marketing_contact_sync_jobs_email_normalized_idx" ON "marketing_contact_sync_jobs" USING btree ("email_normalized");--> statement-breakpoint
CREATE INDEX "marketing_contact_sync_jobs_created_at_idx" ON "marketing_contact_sync_jobs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "marketing_contact_sync_jobs_submission_id_idx" ON "marketing_contact_sync_jobs" USING btree ("submission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "marketing_contact_sync_jobs_consent_event_id_idx" ON "marketing_contact_sync_jobs" USING btree ("consent_event_id");
