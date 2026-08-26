CREATE TABLE "shipping_rate_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"zone_id" text NOT NULL,
	"size_bucket_id" text NOT NULL,
	"country_code" text NOT NULL,
	"postage_type" text NOT NULL,
	"title" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'CAD' NOT NULL,
	"delivery_max_business_days" integer,
	"insured" boolean DEFAULT true NOT NULL,
	"tracked" boolean DEFAULT true NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipping_rate_cache_amount_check" CHECK ("shipping_rate_cache"."amount_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "product_shipments" ADD COLUMN "flat_rate" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "shipping_rate_cache_zone_bucket_idx" ON "shipping_rate_cache" USING btree ("zone_id","size_bucket_id");