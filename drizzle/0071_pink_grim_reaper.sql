CREATE TYPE "public"."marketing_campaign_status" AS ENUM('draft', 'scheduled', 'sending', 'sent', 'failed', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."marketing_contact_sync_job_kind" AS ENUM('opt_in_sync', 'unsubscribe_sync');--> statement-breakpoint
CREATE TABLE "marketing_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject" text NOT NULL,
	"preview_text" text,
	"body_html" text NOT NULL,
	"audience_key" text DEFAULT 'all_marketing' NOT NULL,
	"resend_segment_id" text,
	"status" "marketing_campaign_status" DEFAULT 'draft' NOT NULL,
	"resend_broadcast_id" text,
	"recipient_count_estimate" integer,
	"scheduled_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_by_admin_user_id" uuid,
	"last_error" text,
	"last_error_context" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "marketing_contact_sync_jobs" ADD COLUMN "kind" "marketing_contact_sync_job_kind" DEFAULT 'opt_in_sync' NOT NULL;--> statement-breakpoint
ALTER TABLE "marketing_campaigns" ADD CONSTRAINT "marketing_campaigns_created_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("created_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "marketing_campaigns_status_created_at_idx" ON "marketing_campaigns" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "marketing_campaigns_created_at_idx" ON "marketing_campaigns" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "marketing_campaigns_created_by_admin_user_id_idx" ON "marketing_campaigns" USING btree ("created_by_admin_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "marketing_campaigns_resend_broadcast_id_idx" ON "marketing_campaigns" USING btree ("resend_broadcast_id") WHERE "marketing_campaigns"."resend_broadcast_id" IS NOT NULL;