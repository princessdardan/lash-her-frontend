CREATE TYPE "public"."product_stock_movement_kind" AS ENUM('reserve', 'commit', 'release', 'restock', 'return');--> statement-breakpoint
CREATE TABLE "product_stock" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" text NOT NULL,
	"variant_key" text,
	"on_hand" integer DEFAULT 0 NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	"sanity_seed_quantity" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_stock_nonnegative_check" CHECK ("product_stock"."on_hand" >= 0 AND "product_stock"."reserved" >= 0 AND "product_stock"."reserved" <= "product_stock"."on_hand")
);
--> statement-breakpoint
CREATE TABLE "product_stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_stock_id" uuid NOT NULL,
	"order_id" text,
	"kind" "product_stock_movement_kind" NOT NULL,
	"quantity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_stock_movements_quantity_positive_check" CHECK ("product_stock_movements"."quantity" > 0)
);
--> statement-breakpoint
ALTER TABLE "product_stock_movements" ADD CONSTRAINT "product_stock_movements_product_stock_id_product_stock_id_fk" FOREIGN KEY ("product_stock_id") REFERENCES "public"."product_stock"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_stock_product_variant_idx" ON "product_stock" USING btree ("product_id","variant_key") WHERE "product_stock"."variant_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "product_stock_product_no_variant_idx" ON "product_stock" USING btree ("product_id") WHERE "product_stock"."variant_key" IS NULL;--> statement-breakpoint
CREATE INDEX "product_stock_product_id_idx" ON "product_stock" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_stock_movements_order_kind_idx" ON "product_stock_movements" USING btree ("order_id","product_stock_id","kind") WHERE "product_stock_movements"."order_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "product_stock_movements_stock_idx" ON "product_stock_movements" USING btree ("product_stock_id");