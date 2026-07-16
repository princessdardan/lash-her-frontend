CREATE TYPE "public"."square_team_member_mapping_status" AS ENUM('active', 'inactive', 'missing');--> statement-breakpoint
ALTER TABLE "appointment_holds" ADD COLUMN "square_team_member_id" text;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "square_team_member_id" text;--> statement-breakpoint
ALTER TABLE "booking_business_settings" ADD COLUMN "require_square_team_attribution" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_calendar_connections" ADD COLUMN "credential_owner_admin_user_id" uuid;--> statement-breakpoint
ALTER TABLE "booking_payment_attempts" ADD COLUMN "square_team_member_id" text;--> statement-breakpoint
ALTER TABLE "booking_providers" ADD COLUMN "square_team_member_id" text;--> statement-breakpoint
ALTER TABLE "booking_providers" ADD COLUMN "square_team_member_display_label" text;--> statement-breakpoint
ALTER TABLE "booking_providers" ADD COLUMN "square_team_member_status" "square_team_member_mapping_status";--> statement-breakpoint
ALTER TABLE "booking_providers" ADD COLUMN "square_team_member_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "booking_calendar_connections" ADD CONSTRAINT "booking_calendar_connections_credential_owner_admin_user_id_admin_users_id_fk" FOREIGN KEY ("credential_owner_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "booking_calendar_connections_credential_owner_idx" ON "booking_calendar_connections" USING btree ("credential_owner_admin_user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_providers_square_team_member_idx" ON "booking_providers" USING btree ("square_team_member_id");