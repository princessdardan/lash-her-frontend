DROP INDEX IF EXISTS "checkout_orders_helcim_purchase_transaction_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "product_shipping_cases_one_active_idx";--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN IF NOT EXISTS "fulfillment_quarantined_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN IF NOT EXISTS "fulfillment_quarantine_reason" text;--> statement-breakpoint
ALTER TABLE "fulfillment_data_quarantine" ADD COLUMN "redacted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_shipping_cases" ADD COLUMN IF NOT EXISTS "fulfillment_quarantined_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_shipping_cases" ADD COLUMN IF NOT EXISTS "fulfillment_quarantine_reason" text;--> statement-breakpoint
CREATE UNIQUE INDEX "checkout_orders_helcim_purchase_transaction_idx" ON "checkout_orders" USING btree ("helcim_transaction_id") WHERE "checkout_orders"."payment_provider" = 'helcim' AND "checkout_orders"."helcim_transaction_id" IS NOT NULL AND "checkout_orders"."fulfillment_quarantined_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "product_shipping_cases_one_active_idx" ON "product_shipping_cases" USING btree ("order_id",coalesce("shipment_id", '00000000-0000-0000-0000-000000000000'::uuid),"type") WHERE "product_shipping_cases"."status" IN ('open', 'waiting_customer', 'waiting_provider', 'remedy_pending') AND "product_shipping_cases"."fulfillment_quarantined_at" IS NULL;
