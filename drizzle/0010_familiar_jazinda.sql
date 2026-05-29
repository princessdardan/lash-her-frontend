ALTER TABLE "marketing_consent_events" DROP CONSTRAINT "marketing_consent_events_submission_id_marketing_contact_submissions_id_fk";
--> statement-breakpoint
ALTER TABLE "marketing_consent_events" ALTER COLUMN "submission_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "marketing_consent_events" ADD CONSTRAINT "marketing_consent_events_submission_id_marketing_contact_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."marketing_contact_submissions"("id") ON DELETE set null ON UPDATE no action;