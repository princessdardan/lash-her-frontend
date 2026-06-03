CREATE TYPE "public"."admin_audit_action" AS ENUM('admin_access', 'customer_detail_view', 'privacy_request_view', 'privacy_records_lookup', 'privacy_export_attempt', 'privacy_export_completed', 'privacy_export_failed', 'troubleshooting_panel_view', 'audit_log_view', 'privacy_event_created');--> statement-breakpoint
CREATE TYPE "public"."admin_role" AS ENUM('owner', 'operator');--> statement-breakpoint
CREATE TYPE "public"."admin_user_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."privacy_request_event_type" AS ENUM('created', 'note_added', 'records_lookup', 'export_requested', 'export_completed', 'export_failed', 'decision_recorded', 'status_changed');--> statement-breakpoint
CREATE TYPE "public"."privacy_request_status" AS ENUM('open', 'in_review', 'exported', 'pending_technical_action', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."privacy_request_type" AS ENUM('access_export', 'correction', 'deletion', 'redaction', 'privacy_inquiry');--> statement-breakpoint
CREATE TABLE "admin_audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_admin_user_id" uuid,
	"actor_email" text NOT NULL,
	"actor_role" "admin_role" NOT NULL,
	"action" "admin_audit_action" NOT NULL,
	"domain" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"privacy_request_id" uuid,
	"ip_address" text,
	"user_agent" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_user_id" text NOT NULL,
	"email" text NOT NULL,
	"email_normalized" text NOT NULL,
	"display_name" text,
	"role" "admin_role" NOT NULL,
	"status" "admin_user_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "privacy_request_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"privacy_request_id" uuid NOT NULL,
	"actor_admin_user_id" uuid,
	"event_type" "privacy_request_event_type" NOT NULL,
	"message" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "privacy_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_type" "privacy_request_type" NOT NULL,
	"status" "privacy_request_status" DEFAULT 'open' NOT NULL,
	"subject_email" text NOT NULL,
	"subject_email_normalized" text NOT NULL,
	"requester_name" text,
	"requester_notes" text,
	"owner_decision" text,
	"created_by_admin_user_id" uuid,
	"assigned_admin_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_actor_admin_user_id_admin_users_id_fk" FOREIGN KEY ("actor_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_privacy_request_id_privacy_requests_id_fk" FOREIGN KEY ("privacy_request_id") REFERENCES "public"."privacy_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_request_events" ADD CONSTRAINT "privacy_request_events_privacy_request_id_privacy_requests_id_fk" FOREIGN KEY ("privacy_request_id") REFERENCES "public"."privacy_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_request_events" ADD CONSTRAINT "privacy_request_events_actor_admin_user_id_admin_users_id_fk" FOREIGN KEY ("actor_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_created_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("created_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_assigned_admin_user_id_admin_users_id_fk" FOREIGN KEY ("assigned_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_audit_logs_actor_created_idx" ON "admin_audit_logs" USING btree ("actor_admin_user_id","created_at");--> statement-breakpoint
CREATE INDEX "admin_audit_logs_privacy_request_idx" ON "admin_audit_logs" USING btree ("privacy_request_id");--> statement-breakpoint
CREATE INDEX "admin_audit_logs_target_idx" ON "admin_audit_logs" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_users_provider_user_id_idx" ON "admin_users" USING btree ("provider_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_users_email_normalized_idx" ON "admin_users" USING btree ("email_normalized");--> statement-breakpoint
CREATE INDEX "privacy_request_events_request_created_idx" ON "privacy_request_events" USING btree ("privacy_request_id","created_at");--> statement-breakpoint
CREATE INDEX "privacy_requests_subject_email_normalized_idx" ON "privacy_requests" USING btree ("subject_email_normalized");--> statement-breakpoint
CREATE INDEX "privacy_requests_status_idx" ON "privacy_requests" USING btree ("status");
