DROP INDEX "product_shipment_jobs_idempotency_key_idx";--> statement-breakpoint
DROP INDEX "product_shipments_reference_idx";--> statement-breakpoint
DROP INDEX "product_shipments_quote_token_hash_idx";--> statement-breakpoint
DROP INDEX "shipping_package_profiles_slug_idx";--> statement-breakpoint
DROP INDEX "product_shipping_cases_one_active_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "checkout_orders_helcim_purchase_transaction_idx" ON "checkout_orders" USING btree ("helcim_transaction_id") WHERE "checkout_orders"."payment_provider" = 'helcim' AND "checkout_orders"."helcim_transaction_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "product_shipping_cases_one_active_idx" ON "product_shipping_cases" USING btree ("order_id",coalesce("shipment_id", '00000000-0000-0000-0000-000000000000'::uuid),"type") WHERE "product_shipping_cases"."status" IN ('open', 'waiting_customer', 'waiting_provider', 'remedy_pending');