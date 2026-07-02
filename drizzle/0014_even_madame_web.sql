ALTER TABLE "booking_no_show_charge_records" ADD COLUMN "admin_operator_id" text;--> statement-breakpoint
ALTER TABLE "booking_no_show_charge_records" ADD COLUMN "admin_reason" text;--> statement-breakpoint
ALTER TABLE "booking_no_show_charge_records" ADD COLUMN "admin_eligibility_checked_at" timestamp with time zone;