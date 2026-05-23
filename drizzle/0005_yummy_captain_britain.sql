CREATE TYPE "public"."calendar_finalization_status" AS ENUM('not_required', 'pending', 'paid_calendar_pending', 'booked', 'paid_unbookable_rebooking_pending', 'manual_rebooked', 'refund_required', 'refunded', 'failed', 'manual_review');--> statement-breakpoint
CREATE TYPE "public"."payment_event_processing_status" AS ENUM('received', 'processed', 'duplicate', 'ignored', 'failed');--> statement-breakpoint
CREATE TYPE "public"."payment_provider" AS ENUM('helcim', 'square');--> statement-breakpoint
ALTER TYPE "public"."appointment_hold_status" ADD VALUE 'paid_unbookable_rebooking_pending' BEFORE 'released';--> statement-breakpoint
ALTER TYPE "public"."appointment_hold_status" ADD VALUE 'manual_rebooked' BEFORE 'released';--> statement-breakpoint
ALTER TYPE "public"."appointment_hold_status" ADD VALUE 'refund_required' BEFORE 'released';--> statement-breakpoint
ALTER TYPE "public"."appointment_hold_status" ADD VALUE 'refunded' BEFORE 'released';--> statement-breakpoint
ALTER TABLE "checkout_orders" ALTER COLUMN "helcim_invoice_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout_orders" ALTER COLUMN "helcim_invoice_number" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "appointment_holds" ADD COLUMN "payment_provider" "payment_provider" DEFAULT 'helcim' NOT NULL;--> statement-breakpoint
ALTER TABLE "appointment_holds" ADD COLUMN "square_payment_link_id" text;--> statement-breakpoint
ALTER TABLE "appointment_holds" ADD COLUMN "square_payment_link_url" text;--> statement-breakpoint
ALTER TABLE "appointment_holds" ADD COLUMN "square_checkout_id" text;--> statement-breakpoint
ALTER TABLE "appointment_holds" ADD COLUMN "square_payment_id" text;--> statement-breakpoint
ALTER TABLE "appointment_holds" ADD COLUMN "square_order_id" text;--> statement-breakpoint
ALTER TABLE "appointment_holds" ADD COLUMN "finalization_status" "calendar_finalization_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "appointment_holds" ADD COLUMN "finalization_reason" text;--> statement-breakpoint
ALTER TABLE "appointment_holds" ADD COLUMN "manual_review_status" text;--> statement-breakpoint
ALTER TABLE "appointment_holds" ADD COLUMN "manual_review_reason" text;--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "payment_provider" "payment_provider" DEFAULT 'helcim' NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "provider_checkout_id" text;--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "provider_order_id" text;--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "provider_payment_id" text;--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "provider_status" text;--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "provider_metadata" jsonb;--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "square_payment_link_id" text;--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "square_payment_link_url" text;--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "square_location_id" text;--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "square_tip_amount_cents" integer;--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "calendar_finalization_status" "calendar_finalization_status" DEFAULT 'not_required' NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "calendar_event_id" text;--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "finalized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "checkout_payment_events" ADD COLUMN "payment_provider" "payment_provider" DEFAULT 'helcim' NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout_payment_events" ADD COLUMN "provider_event_id" text;--> statement-breakpoint
ALTER TABLE "checkout_payment_events" ADD COLUMN "provider_checkout_id" text;--> statement-breakpoint
ALTER TABLE "checkout_payment_events" ADD COLUMN "provider_order_id" text;--> statement-breakpoint
ALTER TABLE "checkout_payment_events" ADD COLUMN "provider_payment_id" text;--> statement-breakpoint
ALTER TABLE "checkout_payment_events" ADD COLUMN "provider_status" text;--> statement-breakpoint
ALTER TABLE "checkout_payment_events" ADD COLUMN "payload_hash" text;--> statement-breakpoint
ALTER TABLE "checkout_payment_events" ADD COLUMN "payload_sanitized" jsonb;--> statement-breakpoint
ALTER TABLE "checkout_payment_events" ADD COLUMN "processing_status" "payment_event_processing_status" DEFAULT 'received' NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout_payment_events" ADD COLUMN "processed_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_holds_square_payment_link_id_idx" ON "appointment_holds" USING btree ("square_payment_link_id");--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_holds_square_checkout_id_idx" ON "appointment_holds" USING btree ("square_checkout_id");--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_holds_square_payment_id_idx" ON "appointment_holds" USING btree ("square_payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_holds_square_order_id_idx" ON "appointment_holds" USING btree ("square_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_holds_google_event_id_idx" ON "appointment_holds" USING btree ("google_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "checkout_orders_provider_checkout_idx" ON "checkout_orders" USING btree ("payment_provider","provider_checkout_id");--> statement-breakpoint
CREATE UNIQUE INDEX "checkout_orders_provider_order_idx" ON "checkout_orders" USING btree ("payment_provider","provider_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "checkout_orders_provider_payment_idx" ON "checkout_orders" USING btree ("payment_provider","provider_payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "checkout_orders_calendar_event_id_idx" ON "checkout_orders" USING btree ("calendar_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "checkout_payment_events_provider_event_idx" ON "checkout_payment_events" USING btree ("payment_provider","provider_event_id");