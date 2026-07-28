-- Reconcile the abandoned admin-dashboard migration lineage before creating
-- the current booking-operations schema. The legacy objects are removed only
-- when their exact schema signature is present and every legacy table is
-- empty. Any database with legacy data or an unknown partial schema aborts
-- this transaction without changing existing application data.
DO $$
DECLARE
	legacy_admin_roles text[];
BEGIN
	SELECT array_agg(enum_value.enumlabel::text ORDER BY enum_value.enumsortorder)
	INTO legacy_admin_roles
	FROM pg_type enum_type
	INNER JOIN pg_namespace enum_namespace
		ON enum_namespace.oid = enum_type.typnamespace
	INNER JOIN pg_enum enum_value
		ON enum_value.enumtypid = enum_type.oid
	WHERE enum_namespace.nspname = 'public'
		AND enum_type.typname = 'admin_role';

	IF legacy_admin_roles IS NULL THEN
		IF to_regtype('public.admin_role') IS NOT NULL
			OR to_regtype('public.admin_audit_action') IS NOT NULL
			OR to_regtype('public.admin_user_status') IS NOT NULL
			OR to_regclass('public.admin_users') IS NOT NULL
			OR to_regclass('public.admin_audit_logs') IS NOT NULL
			OR to_regclass('public.privacy_requests') IS NOT NULL
			OR to_regclass('public.privacy_request_events') IS NOT NULL
		THEN
			RAISE EXCEPTION USING
				ERRCODE = '55000',
				MESSAGE = 'Unsupported partial legacy admin schema detected before migration 0018';
		END IF;
	ELSIF legacy_admin_roles <> ARRAY['owner', 'operator']::text[] THEN
		RAISE EXCEPTION USING
			ERRCODE = '55000',
			MESSAGE = format(
				'Unsupported public.admin_role values before migration 0018: %s',
				legacy_admin_roles
			);
	ELSE
		IF to_regtype('public.admin_audit_action') IS NULL
			OR to_regtype('public.admin_user_status') IS NULL
			OR to_regtype('public.privacy_request_event_type') IS NULL
			OR to_regtype('public.privacy_request_status') IS NULL
			OR to_regtype('public.privacy_request_type') IS NULL
			OR to_regclass('public.admin_users') IS NULL
			OR to_regclass('public.admin_audit_logs') IS NULL
			OR to_regclass('public.privacy_requests') IS NULL
			OR to_regclass('public.privacy_request_events') IS NULL
			OR to_regtype('public.admin_audit_outcome') IS NOT NULL
			OR NOT EXISTS (
				SELECT 1
				FROM information_schema.columns
				WHERE table_schema = 'public'
					AND table_name = 'admin_audit_logs'
					AND column_name = 'actor_email'
			)
			OR NOT EXISTS (
				SELECT 1
				FROM information_schema.columns
				WHERE table_schema = 'public'
					AND table_name = 'admin_audit_logs'
					AND column_name = 'privacy_request_id'
			)
		THEN
			RAISE EXCEPTION USING
				ERRCODE = '55000',
				MESSAGE = 'Legacy admin schema does not match the expected abandoned migration lineage';
		END IF;

		IF EXISTS (SELECT 1 FROM public.admin_users LIMIT 1)
			OR EXISTS (SELECT 1 FROM public.admin_audit_logs LIMIT 1)
			OR EXISTS (SELECT 1 FROM public.privacy_requests LIMIT 1)
			OR EXISTS (SELECT 1 FROM public.privacy_request_events LIMIT 1)
		THEN
			RAISE EXCEPTION USING
				ERRCODE = '55000',
				MESSAGE = 'Legacy admin/privacy tables contain data; migration 0018 requires a data-preserving migration plan';
		END IF;

		DROP TABLE public.admin_audit_logs;
		DROP TABLE public.privacy_request_events;
		DROP TABLE public.privacy_requests;
		DROP TABLE public.admin_users;

		DROP TYPE public.admin_audit_action;
		DROP TYPE public.admin_role;
		DROP TYPE public.admin_user_status;
		DROP TYPE public.privacy_request_event_type;
		DROP TYPE public.privacy_request_status;
		DROP TYPE public.privacy_request_type;
	END IF;
END
$$;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "btree_gist";--> statement-breakpoint
CREATE TYPE "public"."admin_audit_outcome" AS ENUM('success', 'denied', 'failure');--> statement-breakpoint
CREATE TYPE "public"."admin_role" AS ENUM('owner', 'admin', 'employee');--> statement-breakpoint
CREATE TYPE "public"."admin_user_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."appointment_calendar_sync_status" AS ENUM('not_required', 'pending', 'synced', 'retryable_failed', 'manual_followup');--> statement-breakpoint
CREATE TYPE "public"."appointment_origin" AS ENUM('online', 'admin', 'imported');--> statement-breakpoint
CREATE TYPE "public"."appointment_payment_status" AS ENUM('not_required', 'pending', 'partially_paid', 'paid', 'refund_required', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."appointment_status" AS ENUM('confirmed', 'cancelled', 'completed', 'no_show', 'rebooking_pending', 'manual_followup');--> statement-breakpoint
CREATE TYPE "public"."booking_calendar_assignment_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."booking_calendar_connection_status" AS ENUM('active', 'reconnect_required', 'revoked', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."booking_calendar_provider" AS ENUM('google');--> statement-breakpoint
CREATE TYPE "public"."booking_configuration_status" AS ENUM('draft', 'active', 'disabled', 'archived');--> statement-breakpoint
CREATE TYPE "public"."booking_offering_resource_role" AS ENUM('provider', 'room', 'equipment');--> statement-breakpoint
CREATE TYPE "public"."booking_payment_attempt_status" AS ENUM('pending', 'authorized', 'captured', 'failed', 'cancelled', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."booking_reservation_kind" AS ENUM('hold', 'appointment', 'block');--> statement-breakpoint
CREATE TYPE "public"."booking_reservation_state" AS ENUM('active', 'released');--> statement-breakpoint
CREATE TYPE "public"."booking_resource_kind" AS ENUM('provider', 'room', 'equipment');--> statement-breakpoint
CREATE TYPE "public"."booking_schedule_exception_kind" AS ENUM('available', 'unavailable');--> statement-breakpoint
CREATE TYPE "public"."booking_schedule_exception_status" AS ENUM('active', 'cancelled');--> statement-breakpoint
CREATE TABLE "admin_audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_admin_user_id" uuid,
	"actor_role" "admin_role" NOT NULL,
	"action" text NOT NULL,
	"domain" text NOT NULL,
	"outcome" "admin_audit_outcome" NOT NULL,
	"target_type" text,
	"target_id" text,
	"reason" text,
	"correlation_id" text,
	"ip_hash" text,
	"user_agent_hash" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_user_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_user_id" uuid NOT NULL,
	"booking_resource_id" uuid NOT NULL,
	"created_by_admin_user_id" uuid,
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
	"last_signed_in_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appointment_calendar_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"appointment_id" uuid NOT NULL,
	"calendar_assignment_id" uuid NOT NULL,
	"provider_calendar_id" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"provider_event_etag" text,
	"sync_status" "appointment_calendar_sync_status" DEFAULT 'pending' NOT NULL,
	"last_attempted_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"last_error_code" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appointment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"appointment_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"source" text NOT NULL,
	"actor_admin_user_id" uuid,
	"previous_status" "appointment_status",
	"next_status" "appointment_status",
	"reason" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appointments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_reference" text NOT NULL,
	"source_hold_id" uuid,
	"source_hold_public_reference" text,
	"checkout_order_id" uuid,
	"service_offering_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"primary_resource_id" uuid NOT NULL,
	"offering_snapshot" jsonb NOT NULL,
	"provider_snapshot" jsonb NOT NULL,
	"customer_name" text NOT NULL,
	"customer_email" text NOT NULL,
	"customer_email_normalized" text NOT NULL,
	"customer_phone" text,
	"intake_snapshot" jsonb,
	"selected_start" timestamp with time zone NOT NULL,
	"selected_end" timestamp with time zone NOT NULL,
	"occupied_start" timestamp with time zone NOT NULL,
	"occupied_end" timestamp with time zone NOT NULL,
	"timezone" text NOT NULL,
	"status" "appointment_status" DEFAULT 'confirmed' NOT NULL,
	"origin" "appointment_origin" DEFAULT 'online' NOT NULL,
	"payment_status" "appointment_payment_status" DEFAULT 'pending' NOT NULL,
	"calendar_sync_status" "appointment_calendar_sync_status" DEFAULT 'pending' NOT NULL,
	"calendar_sync_last_error_code" text,
	"cancellation_reason" text,
	"booking_confirmation_email_sent_at" timestamp with time zone,
	"booking_confirmation_email_claimed_until" timestamp with time zone,
	"booking_confirmation_email_last_error" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_admin_user_id" uuid,
	"confirmed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"no_show_at" timestamp with time zone,
	"redacted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointments_selected_range_check" CHECK ("appointments"."selected_end" > "appointments"."selected_start"),
	CONSTRAINT "appointments_occupied_range_check" CHECK ("appointments"."occupied_end" > "appointments"."occupied_start" AND "appointments"."occupied_start" <= "appointments"."selected_start" AND "appointments"."occupied_end" >= "appointments"."selected_end")
);
--> statement-breakpoint
CREATE TABLE "booking_business_settings" (
	"singleton_key" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"timezone" text DEFAULT 'America/Toronto' NOT NULL,
	"booking_horizon_days" integer DEFAULT 30 NOT NULL,
	"minimum_lead_time_hours" integer DEFAULT 24 NOT NULL,
	"slot_interval_minutes" integer DEFAULT 15 NOT NULL,
	"default_buffer_before_minutes" integer DEFAULT 15 NOT NULL,
	"default_buffer_after_minutes" integer DEFAULT 15 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by_admin_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_business_settings_singleton_check" CHECK ("booking_business_settings"."singleton_key" = 'default'),
	CONSTRAINT "booking_business_settings_values_check" CHECK ("booking_business_settings"."booking_horizon_days" > 0 AND "booking_business_settings"."minimum_lead_time_hours" >= 0 AND "booking_business_settings"."slot_interval_minutes" > 0 AND "booking_business_settings"."default_buffer_before_minutes" >= 0 AND "booking_business_settings"."default_buffer_after_minutes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "booking_calendar_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "booking_calendar_provider" DEFAULT 'google' NOT NULL,
	"provider_account_id" text,
	"account_email" text,
	"credential_ciphertext" text,
	"credential_secret_ref" text,
	"scopes" jsonb,
	"status" "booking_calendar_connection_status" DEFAULT 'reconnect_required' NOT NULL,
	"connected_by_admin_user_id" uuid,
	"last_verified_at" timestamp with time zone,
	"last_error_code" text,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_calendar_connections_active_credential_check" CHECK ("booking_calendar_connections"."status" <> 'active' OR num_nonnulls("booking_calendar_connections"."credential_ciphertext", "booking_calendar_connections"."credential_secret_ref") = 1)
);
--> statement-breakpoint
CREATE TABLE "booking_payment_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hold_id" uuid,
	"appointment_id" uuid,
	"checkout_order_id" uuid,
	"operation" text NOT NULL,
	"status" "booking_payment_attempt_status" DEFAULT 'pending' NOT NULL,
	"payment_provider" "payment_provider" NOT NULL,
	"idempotency_key" text NOT NULL,
	"provider_payment_id" text,
	"provider_order_id" text,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'CAD' NOT NULL,
	"failure_code" text,
	"provider_metadata" jsonb,
	"authorized_at" timestamp with time zone,
	"captured_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_payment_attempts_amount_check" CHECK ("booking_payment_attempts"."amount_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "booking_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_key" text NOT NULL,
	"display_name" text NOT NULL,
	"primary_resource_id" uuid NOT NULL,
	"sanity_document_id" text,
	"public_slug" text,
	"status" "booking_configuration_status" DEFAULT 'draft' NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_by_admin_user_id" uuid,
	"updated_by_admin_user_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "booking_resource_calendar_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource_id" uuid NOT NULL,
	"calendar_connection_id" uuid NOT NULL,
	"provider_calendar_id" text NOT NULL,
	"calendar_label" text,
	"contributes_busy" boolean DEFAULT true NOT NULL,
	"accepts_bookings" boolean DEFAULT false NOT NULL,
	"status" "booking_calendar_assignment_status" DEFAULT 'active' NOT NULL,
	"last_verified_at" timestamp with time zone,
	"last_error_code" text,
	"created_by_admin_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_resource_calendar_assignments_role_check" CHECK ("booking_resource_calendar_assignments"."contributes_busy" = true OR "booking_resource_calendar_assignments"."accepts_bookings" = false)
);
--> statement-breakpoint
CREATE TABLE "booking_resource_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource_id" uuid NOT NULL,
	"hold_id" uuid,
	"appointment_id" uuid,
	"schedule_exception_id" uuid,
	"kind" "booking_reservation_kind" NOT NULL,
	"state" "booking_reservation_state" DEFAULT 'active' NOT NULL,
	"occupied_start" timestamp with time zone NOT NULL,
	"occupied_end" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"release_reason" text,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_resource_reservations_parent_check" CHECK (num_nonnulls("booking_resource_reservations"."hold_id", "booking_resource_reservations"."appointment_id", "booking_resource_reservations"."schedule_exception_id") = 1),
	CONSTRAINT "booking_resource_reservations_kind_check" CHECK (("booking_resource_reservations"."kind" = 'hold' AND "booking_resource_reservations"."hold_id" IS NOT NULL AND "booking_resource_reservations"."expires_at" IS NOT NULL) OR ("booking_resource_reservations"."kind" = 'appointment' AND "booking_resource_reservations"."appointment_id" IS NOT NULL) OR ("booking_resource_reservations"."kind" = 'block' AND "booking_resource_reservations"."schedule_exception_id" IS NOT NULL)),
	CONSTRAINT "booking_resource_reservations_range_check" CHECK ("booking_resource_reservations"."occupied_end" > "booking_resource_reservations"."occupied_start")
);
--> statement-breakpoint
CREATE TABLE "booking_resource_schedule_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource_id" uuid NOT NULL,
	"kind" "booking_schedule_exception_kind" NOT NULL,
	"status" "booking_schedule_exception_status" DEFAULT 'active' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"timezone" text NOT NULL,
	"reason_code" text,
	"note" text,
	"created_by_admin_user_id" uuid,
	"updated_by_admin_user_id" uuid,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_resource_schedule_exceptions_range_check" CHECK ("booking_resource_schedule_exceptions"."ends_at" > "booking_resource_schedule_exceptions"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "booking_resource_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource_id" uuid NOT NULL,
	"weekday" smallint NOT NULL,
	"starts_at" time NOT NULL,
	"ends_at" time NOT NULL,
	"timezone" text NOT NULL,
	"effective_from" date NOT NULL,
	"effective_until" date,
	"status" "booking_configuration_status" DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_admin_user_id" uuid,
	"updated_by_admin_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_resource_schedules_weekday_check" CHECK ("booking_resource_schedules"."weekday" BETWEEN 1 AND 7),
	CONSTRAINT "booking_resource_schedules_time_check" CHECK ("booking_resource_schedules"."ends_at" > "booking_resource_schedules"."starts_at"),
	CONSTRAINT "booking_resource_schedules_effective_range_check" CHECK ("booking_resource_schedules"."effective_until" IS NULL OR "booking_resource_schedules"."effective_until" >= "booking_resource_schedules"."effective_from")
);
--> statement-breakpoint
CREATE TABLE "booking_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource_key" text NOT NULL,
	"name" text NOT NULL,
	"kind" "booking_resource_kind" NOT NULL,
	"timezone" text NOT NULL,
	"status" "booking_configuration_status" DEFAULT 'draft' NOT NULL,
	"created_by_admin_user_id" uuid,
	"updated_by_admin_user_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "booking_service_offering_add_ons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offering_id" uuid NOT NULL,
	"add_on_key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"price_cents" integer NOT NULL,
	"duration_delta_minutes" integer DEFAULT 0 NOT NULL,
	"status" "booking_configuration_status" DEFAULT 'active' NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_service_offering_add_ons_price_check" CHECK ("booking_service_offering_add_ons"."price_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "booking_service_offering_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offering_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"role" "booking_offering_resource_role" NOT NULL,
	"is_required" boolean DEFAULT true NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "booking_service_offerings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offering_key" text NOT NULL,
	"service_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"primary_resource_id" uuid NOT NULL,
	"status" "booking_configuration_status" DEFAULT 'draft' NOT NULL,
	"booking_type" text DEFAULT 'in-person-appointment' NOT NULL,
	"duration_minutes" integer NOT NULL,
	"slot_interval_minutes" integer DEFAULT 15 NOT NULL,
	"buffer_before_minutes" integer DEFAULT 0 NOT NULL,
	"buffer_after_minutes" integer DEFAULT 0 NOT NULL,
	"full_price_cents" integer NOT NULL,
	"deposit_amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'CAD' NOT NULL,
	"minimum_lead_time_hours" integer,
	"booking_horizon_days" integer,
	"display_order" integer DEFAULT 0 NOT NULL,
	"effective_from" timestamp with time zone,
	"effective_until" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_admin_user_id" uuid,
	"updated_by_admin_user_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_service_offerings_duration_check" CHECK ("booking_service_offerings"."duration_minutes" > 0 AND "booking_service_offerings"."slot_interval_minutes" > 0),
	CONSTRAINT "booking_service_offerings_buffer_check" CHECK ("booking_service_offerings"."buffer_before_minutes" >= 0 AND "booking_service_offerings"."buffer_after_minutes" >= 0),
	CONSTRAINT "booking_service_offerings_price_check" CHECK ("booking_service_offerings"."full_price_cents" > 0 AND "booking_service_offerings"."deposit_amount_cents" > 0 AND "booking_service_offerings"."deposit_amount_cents" < "booking_service_offerings"."full_price_cents"),
	CONSTRAINT "booking_service_offerings_effective_range_check" CHECK ("booking_service_offerings"."effective_until" IS NULL OR "booking_service_offerings"."effective_from" IS NULL OR "booking_service_offerings"."effective_until" > "booking_service_offerings"."effective_from")
);
--> statement-breakpoint
CREATE TABLE "booking_services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_key" text NOT NULL,
	"display_title" text NOT NULL,
	"sanity_document_id" text,
	"public_slug" text,
	"status" "booking_configuration_status" DEFAULT 'draft' NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_by_admin_user_id" uuid,
	"updated_by_admin_user_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "appointment_holds" ADD COLUMN "booking_model_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "appointment_holds" ADD COLUMN "service_offering_id" uuid;--> statement-breakpoint
ALTER TABLE "appointment_holds" ADD COLUMN "provider_id" uuid;--> statement-breakpoint
ALTER TABLE "appointment_holds" ADD COLUMN "primary_resource_id" uuid;--> statement-breakpoint
ALTER TABLE "appointment_holds" ADD COLUMN "provider_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "appointment_holds" ADD COLUMN "configuration_version" integer;--> statement-breakpoint
ALTER TABLE "appointment_holds" ADD COLUMN "occupied_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointment_holds" ADD COLUMN "occupied_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointment_holds" ADD COLUMN "calendar_assignment_id" uuid;--> statement-breakpoint
ALTER TABLE "appointment_holds" ADD COLUMN "google_calendar_id" text;--> statement-breakpoint
ALTER TABLE "booking_no_show_charge_records" ADD COLUMN "appointment_id" uuid;--> statement-breakpoint
ALTER TABLE "booking_policy_acceptances" ADD COLUMN "appointment_id" uuid;--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_actor_admin_user_id_admin_users_id_fk" FOREIGN KEY ("actor_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_user_resources" ADD CONSTRAINT "admin_user_resources_admin_user_id_admin_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_user_resources" ADD CONSTRAINT "admin_user_resources_booking_resource_id_booking_resources_id_fk" FOREIGN KEY ("booking_resource_id") REFERENCES "public"."booking_resources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_user_resources" ADD CONSTRAINT "admin_user_resources_created_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("created_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_calendar_events" ADD CONSTRAINT "appointment_calendar_events_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_calendar_events" ADD CONSTRAINT "appointment_calendar_events_calendar_assignment_id_booking_resource_calendar_assignments_id_fk" FOREIGN KEY ("calendar_assignment_id") REFERENCES "public"."booking_resource_calendar_assignments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_events" ADD CONSTRAINT "appointment_events_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_events" ADD CONSTRAINT "appointment_events_actor_admin_user_id_admin_users_id_fk" FOREIGN KEY ("actor_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_source_hold_id_appointment_holds_id_fk" FOREIGN KEY ("source_hold_id") REFERENCES "public"."appointment_holds"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_checkout_order_id_checkout_orders_id_fk" FOREIGN KEY ("checkout_order_id") REFERENCES "public"."checkout_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_service_offering_id_booking_service_offerings_id_fk" FOREIGN KEY ("service_offering_id") REFERENCES "public"."booking_service_offerings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_provider_id_booking_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."booking_providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_primary_resource_id_booking_resources_id_fk" FOREIGN KEY ("primary_resource_id") REFERENCES "public"."booking_resources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_created_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("created_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_business_settings" ADD CONSTRAINT "booking_business_settings_updated_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("updated_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_calendar_connections" ADD CONSTRAINT "booking_calendar_connections_connected_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("connected_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_payment_attempts" ADD CONSTRAINT "booking_payment_attempts_hold_id_appointment_holds_id_fk" FOREIGN KEY ("hold_id") REFERENCES "public"."appointment_holds"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_payment_attempts" ADD CONSTRAINT "booking_payment_attempts_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_payment_attempts" ADD CONSTRAINT "booking_payment_attempts_checkout_order_id_checkout_orders_id_fk" FOREIGN KEY ("checkout_order_id") REFERENCES "public"."checkout_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_providers" ADD CONSTRAINT "booking_providers_primary_resource_id_booking_resources_id_fk" FOREIGN KEY ("primary_resource_id") REFERENCES "public"."booking_resources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_providers" ADD CONSTRAINT "booking_providers_created_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("created_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_providers" ADD CONSTRAINT "booking_providers_updated_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("updated_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_resource_calendar_assignments" ADD CONSTRAINT "booking_resource_calendar_assignments_resource_id_booking_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."booking_resources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_resource_calendar_assignments" ADD CONSTRAINT "booking_resource_calendar_assignments_calendar_connection_id_booking_calendar_connections_id_fk" FOREIGN KEY ("calendar_connection_id") REFERENCES "public"."booking_calendar_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_resource_calendar_assignments" ADD CONSTRAINT "booking_resource_calendar_assignments_created_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("created_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_resource_reservations" ADD CONSTRAINT "booking_resource_reservations_resource_id_booking_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."booking_resources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_resource_reservations" ADD CONSTRAINT "booking_resource_reservations_hold_id_appointment_holds_id_fk" FOREIGN KEY ("hold_id") REFERENCES "public"."appointment_holds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_resource_reservations" ADD CONSTRAINT "booking_resource_reservations_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_resource_reservations" ADD CONSTRAINT "booking_resource_reservations_schedule_exception_id_booking_resource_schedule_exceptions_id_fk" FOREIGN KEY ("schedule_exception_id") REFERENCES "public"."booking_resource_schedule_exceptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_resource_schedule_exceptions" ADD CONSTRAINT "booking_resource_schedule_exceptions_resource_id_booking_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."booking_resources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_resource_schedule_exceptions" ADD CONSTRAINT "booking_resource_schedule_exceptions_created_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("created_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_resource_schedule_exceptions" ADD CONSTRAINT "booking_resource_schedule_exceptions_updated_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("updated_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_resource_schedules" ADD CONSTRAINT "booking_resource_schedules_resource_id_booking_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."booking_resources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_resource_schedules" ADD CONSTRAINT "booking_resource_schedules_created_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("created_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_resource_schedules" ADD CONSTRAINT "booking_resource_schedules_updated_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("updated_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_resources" ADD CONSTRAINT "booking_resources_created_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("created_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_resources" ADD CONSTRAINT "booking_resources_updated_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("updated_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_service_offering_add_ons" ADD CONSTRAINT "booking_service_offering_add_ons_offering_id_booking_service_offerings_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."booking_service_offerings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_service_offering_resources" ADD CONSTRAINT "booking_service_offering_resources_offering_id_booking_service_offerings_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."booking_service_offerings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_service_offering_resources" ADD CONSTRAINT "booking_service_offering_resources_resource_id_booking_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."booking_resources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_service_offerings" ADD CONSTRAINT "booking_service_offerings_service_id_booking_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."booking_services"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_service_offerings" ADD CONSTRAINT "booking_service_offerings_provider_id_booking_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."booking_providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_service_offerings" ADD CONSTRAINT "booking_service_offerings_primary_resource_id_booking_resources_id_fk" FOREIGN KEY ("primary_resource_id") REFERENCES "public"."booking_resources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_service_offerings" ADD CONSTRAINT "booking_service_offerings_created_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("created_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_service_offerings" ADD CONSTRAINT "booking_service_offerings_updated_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("updated_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_services" ADD CONSTRAINT "booking_services_created_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("created_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_services" ADD CONSTRAINT "booking_services_updated_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("updated_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_audit_logs_actor_created_idx" ON "admin_audit_logs" USING btree ("actor_admin_user_id","created_at");--> statement-breakpoint
CREATE INDEX "admin_audit_logs_domain_created_idx" ON "admin_audit_logs" USING btree ("domain","created_at");--> statement-breakpoint
CREATE INDEX "admin_audit_logs_target_created_idx" ON "admin_audit_logs" USING btree ("target_type","target_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_user_resources_user_resource_idx" ON "admin_user_resources" USING btree ("admin_user_id","booking_resource_id");--> statement-breakpoint
CREATE INDEX "admin_user_resources_resource_user_idx" ON "admin_user_resources" USING btree ("booking_resource_id","admin_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_users_provider_user_id_idx" ON "admin_users" USING btree ("provider_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_users_email_normalized_idx" ON "admin_users" USING btree ("email_normalized");--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_calendar_events_assignment_event_idx" ON "appointment_calendar_events" USING btree ("calendar_assignment_id","provider_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_calendar_events_active_appointment_idx" ON "appointment_calendar_events" USING btree ("appointment_id","calendar_assignment_id") WHERE "appointment_calendar_events"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "appointment_calendar_events_sync_status_idx" ON "appointment_calendar_events" USING btree ("sync_status","last_attempted_at");--> statement-breakpoint
CREATE INDEX "appointment_events_appointment_created_idx" ON "appointment_events" USING btree ("appointment_id","created_at");--> statement-breakpoint
CREATE INDEX "appointment_events_type_created_idx" ON "appointment_events" USING btree ("event_type","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "appointments_public_reference_idx" ON "appointments" USING btree ("public_reference");--> statement-breakpoint
CREATE UNIQUE INDEX "appointments_source_hold_idx" ON "appointments" USING btree ("source_hold_id");--> statement-breakpoint
CREATE INDEX "appointments_provider_start_idx" ON "appointments" USING btree ("provider_id","selected_start");--> statement-breakpoint
CREATE INDEX "appointments_resource_start_idx" ON "appointments" USING btree ("primary_resource_id","selected_start");--> statement-breakpoint
CREATE INDEX "appointments_status_start_idx" ON "appointments" USING btree ("status","selected_start");--> statement-breakpoint
CREATE INDEX "appointments_customer_email_idx" ON "appointments" USING btree ("customer_email_normalized","created_at");--> statement-breakpoint
CREATE INDEX "appointments_checkout_order_idx" ON "appointments" USING btree ("checkout_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_calendar_connections_provider_account_idx" ON "booking_calendar_connections" USING btree ("provider","provider_account_id");--> statement-breakpoint
CREATE INDEX "booking_calendar_connections_status_idx" ON "booking_calendar_connections" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_payment_attempts_idempotency_idx" ON "booking_payment_attempts" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_payment_attempts_provider_payment_idx" ON "booking_payment_attempts" USING btree ("payment_provider","provider_payment_id");--> statement-breakpoint
CREATE INDEX "booking_payment_attempts_hold_created_idx" ON "booking_payment_attempts" USING btree ("hold_id","created_at");--> statement-breakpoint
CREATE INDEX "booking_payment_attempts_appointment_created_idx" ON "booking_payment_attempts" USING btree ("appointment_id","created_at");--> statement-breakpoint
CREATE INDEX "booking_payment_attempts_status_created_idx" ON "booking_payment_attempts" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_providers_provider_key_idx" ON "booking_providers" USING btree ("provider_key");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_providers_primary_resource_idx" ON "booking_providers" USING btree ("primary_resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_providers_sanity_document_idx" ON "booking_providers" USING btree ("sanity_document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_providers_public_slug_idx" ON "booking_providers" USING btree ("public_slug");--> statement-breakpoint
CREATE INDEX "booking_providers_status_display_idx" ON "booking_providers" USING btree ("status","display_order");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_resource_calendar_assignments_calendar_idx" ON "booking_resource_calendar_assignments" USING btree ("resource_id","calendar_connection_id","provider_calendar_id");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_resource_calendar_assignments_write_idx" ON "booking_resource_calendar_assignments" USING btree ("resource_id") WHERE "booking_resource_calendar_assignments"."status" = 'active' AND "booking_resource_calendar_assignments"."accepts_bookings" = true;--> statement-breakpoint
CREATE INDEX "booking_resource_calendar_assignments_busy_idx" ON "booking_resource_calendar_assignments" USING btree ("resource_id","status","contributes_busy");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_resource_reservations_hold_idx" ON "booking_resource_reservations" USING btree ("resource_id","hold_id");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_resource_reservations_appointment_idx" ON "booking_resource_reservations" USING btree ("resource_id","appointment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_resource_reservations_exception_idx" ON "booking_resource_reservations" USING btree ("resource_id","schedule_exception_id");--> statement-breakpoint
CREATE INDEX "booking_resource_reservations_active_lookup_idx" ON "booking_resource_reservations" USING btree ("resource_id","state","occupied_start","occupied_end");--> statement-breakpoint
CREATE INDEX "booking_resource_reservations_expiry_idx" ON "booking_resource_reservations" USING btree ("state","expires_at");--> statement-breakpoint
CREATE INDEX "booking_resource_schedule_exceptions_lookup_idx" ON "booking_resource_schedule_exceptions" USING btree ("resource_id","status","starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "booking_resource_schedules_lookup_idx" ON "booking_resource_schedules" USING btree ("resource_id","weekday","status","effective_from","effective_until");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_resources_resource_key_idx" ON "booking_resources" USING btree ("resource_key");--> statement-breakpoint
CREATE INDEX "booking_resources_status_kind_idx" ON "booking_resources" USING btree ("status","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_service_offering_add_ons_key_idx" ON "booking_service_offering_add_ons" USING btree ("offering_id","add_on_key");--> statement-breakpoint
CREATE INDEX "booking_service_offering_add_ons_display_idx" ON "booking_service_offering_add_ons" USING btree ("offering_id","status","display_order");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_service_offering_resources_pair_idx" ON "booking_service_offering_resources" USING btree ("offering_id","resource_id");--> statement-breakpoint
CREATE INDEX "booking_service_offering_resources_resource_idx" ON "booking_service_offering_resources" USING btree ("resource_id","offering_id");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_service_offerings_offering_key_idx" ON "booking_service_offerings" USING btree ("offering_key");--> statement-breakpoint
CREATE INDEX "booking_service_offerings_service_provider_idx" ON "booking_service_offerings" USING btree ("service_id","provider_id","status");--> statement-breakpoint
CREATE INDEX "booking_service_offerings_resource_status_idx" ON "booking_service_offerings" USING btree ("primary_resource_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_services_service_key_idx" ON "booking_services" USING btree ("service_key");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_services_sanity_document_idx" ON "booking_services" USING btree ("sanity_document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_services_public_slug_idx" ON "booking_services" USING btree ("public_slug");--> statement-breakpoint
CREATE INDEX "booking_services_status_display_idx" ON "booking_services" USING btree ("status","display_order");--> statement-breakpoint
ALTER TABLE "appointment_holds" ADD CONSTRAINT "appointment_holds_service_offering_id_booking_service_offerings_id_fk" FOREIGN KEY ("service_offering_id") REFERENCES "public"."booking_service_offerings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_holds" ADD CONSTRAINT "appointment_holds_provider_id_booking_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."booking_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_holds" ADD CONSTRAINT "appointment_holds_primary_resource_id_booking_resources_id_fk" FOREIGN KEY ("primary_resource_id") REFERENCES "public"."booking_resources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_holds" ADD CONSTRAINT "appointment_holds_calendar_assignment_id_booking_resource_calendar_assignments_id_fk" FOREIGN KEY ("calendar_assignment_id") REFERENCES "public"."booking_resource_calendar_assignments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_no_show_charge_records" ADD CONSTRAINT "booking_no_show_charge_records_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_policy_acceptances" ADD CONSTRAINT "booking_policy_acceptances_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointment_holds_resource_conflict_idx" ON "appointment_holds" USING btree ("primary_resource_id","occupied_start","occupied_end","status","expires_at");--> statement-breakpoint
CREATE INDEX "appointment_holds_service_offering_idx" ON "appointment_holds" USING btree ("service_offering_id","selected_start");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_no_show_charge_records_appointment_id_idx" ON "booking_no_show_charge_records" USING btree ("appointment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_policy_acceptances_appointment_id_idx" ON "booking_policy_acceptances" USING btree ("appointment_id");--> statement-breakpoint
ALTER TABLE "appointment_holds" ADD CONSTRAINT "appointment_holds_booking_model_v2_check" CHECK ("appointment_holds"."booking_model_version" = 1 OR ("appointment_holds"."service_offering_id" IS NOT NULL AND "appointment_holds"."provider_id" IS NOT NULL AND "appointment_holds"."primary_resource_id" IS NOT NULL AND "appointment_holds"."provider_snapshot" IS NOT NULL AND "appointment_holds"."occupied_start" IS NOT NULL AND "appointment_holds"."occupied_end" IS NOT NULL AND "appointment_holds"."occupied_end" > "appointment_holds"."occupied_start" AND "appointment_holds"."calendar_assignment_id" IS NOT NULL AND "appointment_holds"."google_calendar_id" IS NOT NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "booking_resource_reservations" ADD CONSTRAINT "booking_resource_reservations_no_active_overlap" EXCLUDE USING gist ("resource_id" WITH =, tstzrange("occupied_start", "occupied_end", '[)') WITH &&) WHERE ("state" = 'active');
