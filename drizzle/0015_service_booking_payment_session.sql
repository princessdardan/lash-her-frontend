ALTER TABLE "appointment_holds" ADD COLUMN "payment_session_reference" text;--> statement-breakpoint
UPDATE "appointment_holds"
SET "payment_session_reference" = 'pay_sess_' || replace("id"::text, '-', '')
WHERE "payment_session_reference" IS NULL;--> statement-breakpoint
ALTER TABLE "appointment_holds" ALTER COLUMN "payment_session_reference" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_holds_payment_session_reference_idx" ON "appointment_holds" USING btree ("payment_session_reference");
