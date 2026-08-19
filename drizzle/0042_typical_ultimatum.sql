DROP INDEX IF EXISTS "order_payment_obligations_one_primary_idx";--> statement-breakpoint
ALTER TABLE "order_payment_obligations" ADD COLUMN IF NOT EXISTS "quarantined_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order_payment_obligations" ADD COLUMN IF NOT EXISTS "quarantine_reason" text;--> statement-breakpoint
CREATE UNIQUE INDEX "order_payment_obligations_one_primary_idx" ON "order_payment_obligations" USING btree ("order_id") WHERE "order_payment_obligations"."purpose" = 'primary' AND "order_payment_obligations"."quarantined_at" IS NULL;--> statement-breakpoint
