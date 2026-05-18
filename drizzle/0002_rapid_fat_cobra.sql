CREATE TYPE "public"."marketing_consent_event_type" AS ENUM('opt_in', 'no_opt_in', 'unsubscribe', 'backfill_consent');--> statement-breakpoint
CREATE TYPE "public"."marketing_contact_submission_type" AS ENUM('general_inquiry', 'training_contact', 'contact_popup', 'booking_marketing_choice', 'sanity_backfill');--> statement-breakpoint
CREATE TABLE "marketing_consent_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid,
	"submission_id" uuid NOT NULL,
	"event_type" "marketing_consent_event_type" NOT NULL,
	"email" text NOT NULL,
	"email_normalized" text NOT NULL,
	"source" text NOT NULL,
	"consent_text" text,
	"metadata" jsonb,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "marketing_contact_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_type" "marketing_contact_submission_type" NOT NULL,
	"email" text NOT NULL,
	"email_normalized" text NOT NULL,
	"name" text,
	"phone" text,
	"instagram" text,
	"source" text NOT NULL,
	"source_path" text,
	"source_system" text DEFAULT 'website' NOT NULL,
	"source_document_type" text,
	"source_document_id" text,
	"consent_choice" text NOT NULL,
	"consent_text" text,
	"payload" jsonb NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "marketing_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"email_normalized" text NOT NULL,
	"name" text,
	"phone" text,
	"instagram" text,
	"source" text NOT NULL,
	"consent_text" text,
	"first_consented_at" timestamp with time zone NOT NULL,
	"last_consented_at" timestamp with time zone NOT NULL,
	"unsubscribed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketing_contacts_email_normalized_unique" UNIQUE("email_normalized")
);
--> statement-breakpoint
ALTER TABLE "marketing_consent_events" ADD CONSTRAINT "marketing_consent_events_contact_id_marketing_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."marketing_contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_consent_events" ADD CONSTRAINT "marketing_consent_events_submission_id_marketing_contact_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."marketing_contact_submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "marketing_contact_submissions_source_document_idx" ON "marketing_contact_submissions" USING btree ("source_system","source_document_type","source_document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "marketing_contacts_email_normalized_idx" ON "marketing_contacts" USING btree ("email_normalized");
