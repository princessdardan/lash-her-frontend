ALTER TABLE "appointment_holds" ADD COLUMN "booking_confirmation_email_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointment_holds" ADD COLUMN "booking_confirmation_email_claimed_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointment_holds" ADD COLUMN "booking_confirmation_email_last_error" text;--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "product_confirmation_email_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "product_confirmation_email_claimed_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "product_confirmation_email_last_error" text;--> statement-breakpoint
ALTER TABLE "training_enrollments" ADD COLUMN "student_payment_email_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "training_enrollments" ADD COLUMN "training_email_claimed_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "training_enrollments" ADD COLUMN "training_email_last_error" text;--> statement-breakpoint
UPDATE "checkout_orders"
SET "purpose" = 'training'
WHERE "purpose" = 'product'
  AND "id" IN (
    SELECT "checkout_order_id"
    FROM "training_enrollments"
  );
