ALTER TABLE "appointment_holds" ADD COLUMN "provider_booking_email_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointment_holds" ADD COLUMN "provider_booking_email_claimed_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointment_holds" ADD COLUMN "provider_booking_email_last_error" text;