ALTER TABLE "appointment_holds" ADD COLUMN "capture_lease_id" uuid;--> statement-breakpoint
ALTER TABLE "appointment_holds" ADD COLUMN "capture_lease_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "appointment_holds_capture_lease_idx" ON "appointment_holds" USING btree ("capture_lease_expires_at");