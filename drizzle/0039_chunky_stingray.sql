ALTER TABLE "checkout_orders" ADD COLUMN "tax_amount_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "promotion_code" text;--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "promotion_discount_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "manual_discount_cents" integer DEFAULT 0 NOT NULL;