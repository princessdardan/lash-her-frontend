CREATE TABLE "manual_fulfillment_policy_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"policy_snapshot" jsonb NOT NULL,
	"evidence_reference" text,
	"approved_by_admin_user_id" uuid,
	"approved_at" timestamp with time zone,
	"effective_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manual_fulfillment_policy_versions_version_unique" UNIQUE("version"),
	CONSTRAINT "manual_fulfillment_policy_versions_status_check" CHECK ("manual_fulfillment_policy_versions"."status" IN ('draft', 'effective', 'superseded')),
	CONSTRAINT "manual_fulfillment_policy_versions_effective_evidence_check" CHECK ("manual_fulfillment_policy_versions"."status" <> 'effective' OR ("manual_fulfillment_policy_versions"."effective_at" IS NOT NULL AND "manual_fulfillment_policy_versions"."approved_at" IS NOT NULL AND "manual_fulfillment_policy_versions"."approved_by_admin_user_id" IS NOT NULL AND length(trim("manual_fulfillment_policy_versions"."evidence_reference")) > 0 AND "manual_fulfillment_policy_versions"."superseded_at" IS NULL))
);
--> statement-breakpoint
DROP INDEX "order_payment_obligations_provider_invoice_idx";--> statement-breakpoint
DROP INDEX "order_payment_obligations_provider_checkout_idx";--> statement-breakpoint
DROP INDEX "order_payment_obligations_checkout_token_idx";--> statement-breakpoint
ALTER TABLE "manual_fulfillment_policy_versions" ADD CONSTRAINT "manual_fulfillment_policy_versions_approved_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("approved_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "manual_fulfillment_policy_versions_one_effective_idx" ON "manual_fulfillment_policy_versions" USING btree ("status") WHERE "manual_fulfillment_policy_versions"."status" = 'effective';--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD CONSTRAINT "checkout_orders_cancellation_policy_version_manual_fulfillment_policy_versions_version_fk" FOREIGN KEY ("cancellation_policy_version") REFERENCES "public"."manual_fulfillment_policy_versions"("version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "order_payment_obligations_provider_invoice_idx" ON "order_payment_obligations" USING btree ("payment_provider","provider_invoice_id") WHERE "order_payment_obligations"."provider_invoice_id" IS NOT NULL AND "order_payment_obligations"."quarantined_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "order_payment_obligations_provider_checkout_idx" ON "order_payment_obligations" USING btree ("payment_provider","provider_checkout_id") WHERE "order_payment_obligations"."provider_checkout_id" IS NOT NULL AND "order_payment_obligations"."quarantined_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "order_payment_obligations_checkout_token_idx" ON "order_payment_obligations" USING btree ("checkout_token_hash") WHERE "order_payment_obligations"."checkout_token_hash" IS NOT NULL AND "order_payment_obligations"."quarantined_at" IS NULL;