CREATE TYPE "public"."booking_offering_copy_provenance" AS ENUM('legacy', 'admin');--> statement-breakpoint
ALTER TABLE "booking_service_offerings" ADD COLUMN "public_title_provenance" "booking_offering_copy_provenance" DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_service_offerings" ADD COLUMN "public_summary_provenance" "booking_offering_copy_provenance" DEFAULT 'legacy' NOT NULL;
