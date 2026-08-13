CREATE TYPE "public"."checkout_initialization_status" AS ENUM('initializing', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."product_shipment_job_status" AS ENUM('queued', 'processing', 'succeeded', 'retryable_failed', 'dead_letter');--> statement-breakpoint
CREATE TYPE "public"."product_shipment_job_type" AS ENUM('create', 'purchase', 'tracking', 'refund', 'cleanup', 'notification');--> statement-breakpoint
CREATE TYPE "public"."product_shipment_status" AS ENUM('quote_pending', 'quoted', 'quote_unknown', 'payment_pending', 'ready_for_staff', 'purchase_pending', 'label_ready', 'accepted', 'in_transit', 'delivered', 'exception', 'refund_pending', 'voided', 'abandoned', 'manual_review');--> statement-breakpoint
CREATE TABLE "product_shipment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"provider_status" text,
	"normalized_status" "product_shipment_status" NOT NULL,
	"description" text,
	"payload" jsonb,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_shipment_events_fingerprint_unique" UNIQUE("fingerprint")
);
--> statement-breakpoint
CREATE TABLE "product_shipment_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"type" "product_shipment_job_type" NOT NULL,
	"status" "product_shipment_job_status" DEFAULT 'queued' NOT NULL,
	"idempotency_key" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	"outcome_unknown" boolean DEFAULT false NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_shipment_jobs_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "product_shipments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid,
	"public_reference" text NOT NULL,
	"quote_token_hash" text NOT NULL,
	"quote_fingerprint" text NOT NULL,
	"provider" text DEFAULT 'chitchats' NOT NULL,
	"provider_shipment_id" text,
	"provider_status" text,
	"status" "product_shipment_status" DEFAULT 'quote_pending' NOT NULL,
	"destination" jsonb NOT NULL,
	"package_snapshot" jsonb NOT NULL,
	"customs_lines" jsonb NOT NULL,
	"rates" jsonb NOT NULL,
	"selected_rate_id" text,
	"selected_postage_type" text,
	"quoted_shipping_cents" integer,
	"actual_postage_cents" integer,
	"actual_insurance_cents" integer,
	"tracking_number" text,
	"tracking_url" text,
	"raw_shipment" jsonb,
	"quote_expires_at" timestamp with time zone NOT NULL,
	"purchased_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"accepted_email_sent_at" timestamp with time zone,
	"exception_email_sent_at" timestamp with time zone,
	"delivered_email_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"redacted_at" timestamp with time zone,
	CONSTRAINT "product_shipments_public_reference_unique" UNIQUE("public_reference"),
	CONSTRAINT "product_shipments_quote_token_hash_unique" UNIQUE("quote_token_hash"),
	CONSTRAINT "product_shipments_provider_shipment_id_unique" UNIQUE("provider_shipment_id")
);
--> statement-breakpoint
CREATE TABLE "shipping_package_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"rank" integer NOT NULL,
	"package_type" text NOT NULL,
	"length_cm" integer NOT NULL,
	"width_cm" integer NOT NULL,
	"height_cm" integer NOT NULL,
	"tare_weight_grams" integer NOT NULL,
	"max_weight_grams" integer NOT NULL,
	"capacity_units" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipping_package_profiles_slug_unique" UNIQUE("slug"),
	CONSTRAINT "shipping_package_profiles_dimensions_check" CHECK ("shipping_package_profiles"."length_cm" > 0 AND "shipping_package_profiles"."width_cm" > 0 AND "shipping_package_profiles"."height_cm" > 0),
	CONSTRAINT "shipping_package_profiles_capacity_check" CHECK ("shipping_package_profiles"."capacity_units" > 0 AND "shipping_package_profiles"."max_weight_grams" > 0 AND "shipping_package_profiles"."tare_weight_grams" >= 0)
);
--> statement-breakpoint
ALTER TABLE "checkout_orders" ALTER COLUMN "checkout_token_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout_orders" ALTER COLUMN "secret_token_ciphertext" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "initialization_status" "checkout_initialization_status" DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "initialization_error" text;--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "merchandise_amount_cents" integer;--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "shipping_amount_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "product_shipment_events" ADD CONSTRAINT "product_shipment_events_shipment_id_product_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."product_shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_shipment_jobs" ADD CONSTRAINT "product_shipment_jobs_shipment_id_product_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."product_shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_shipments" ADD CONSTRAINT "product_shipments_order_id_checkout_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."checkout_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_shipment_events_shipment_occurred_idx" ON "product_shipment_events" USING btree ("shipment_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "product_shipment_jobs_idempotency_key_idx" ON "product_shipment_jobs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "product_shipment_jobs_claim_idx" ON "product_shipment_jobs" USING btree ("status","available_at","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "product_shipments_order_id_idx" ON "product_shipments" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_shipments_reference_idx" ON "product_shipments" USING btree ("public_reference");--> statement-breakpoint
CREATE UNIQUE INDEX "product_shipments_quote_token_hash_idx" ON "product_shipments" USING btree ("quote_token_hash");--> statement-breakpoint
CREATE INDEX "product_shipments_quote_fingerprint_idx" ON "product_shipments" USING btree ("quote_fingerprint","quote_expires_at");--> statement-breakpoint
CREATE INDEX "product_shipments_poll_idx" ON "product_shipments" USING btree ("status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "shipping_package_profiles_slug_idx" ON "shipping_package_profiles" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "shipping_package_profiles_enabled_rank_idx" ON "shipping_package_profiles" USING btree ("enabled","rank");
--> statement-breakpoint
INSERT INTO "shipping_package_profiles" (
  "slug", "name", "rank", "package_type", "length_cm", "width_cm", "height_cm",
  "tare_weight_grams", "max_weight_grams", "capacity_units", "enabled"
) VALUES
  ('small-mailer', 'Small padded mailer', 10, 'thick_envelope', 23, 15, 4, 40, 500, 2, true),
  ('medium-parcel', 'Medium parcel', 20, 'parcel', 30, 23, 8, 90, 2000, 6, true),
  ('large-parcel', 'Large parcel', 30, 'parcel', 40, 30, 15, 180, 5000, 12, true)
ON CONFLICT ("slug") DO NOTHING;
