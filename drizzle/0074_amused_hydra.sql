ALTER TABLE "product_order_adjustments" DROP CONSTRAINT "product_order_adjustments_source_case_id_product_shipping_cases_id_fk";
--> statement-breakpoint
ALTER TABLE "product_order_refunds" DROP CONSTRAINT "product_order_refunds_case_id_product_shipping_cases_id_fk";
--> statement-breakpoint
ALTER TABLE "product_order_adjustments" DROP COLUMN "source_case_id";--> statement-breakpoint
ALTER TABLE "product_order_refunds" DROP COLUMN "case_id";