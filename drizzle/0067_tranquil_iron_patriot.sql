ALTER TABLE "checkout_orders" ADD COLUMN "terms_version" text;--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "terms_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "terms_snapshot" jsonb;