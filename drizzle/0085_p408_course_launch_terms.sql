ALTER TABLE "course_purchase_jobs" DROP CONSTRAINT "course_purchase_job_kind";--> statement-breakpoint
ALTER TABLE "course_purchase_orders" ADD COLUMN "receipt_seller" jsonb;--> statement-breakpoint
ALTER TABLE "course_purchase_orders" ADD COLUMN "purchase_terms" jsonb;--> statement-breakpoint
ALTER TABLE "course_purchase_orders" ADD COLUMN "terms_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "course_purchase_jobs" ADD CONSTRAINT "course_purchase_refund_receipt_has_refund" CHECK ("course_purchase_jobs"."kind" <> 'refund_receipt' or "course_purchase_jobs"."refund_id" is not null);--> statement-breakpoint
ALTER TABLE "course_purchase_jobs" ADD CONSTRAINT "course_purchase_job_kind" CHECK ("course_purchase_jobs"."kind" in ('grant','revoke','tax_sale','tax_refund','receipt','refund_receipt'));--> statement-breakpoint
ALTER TABLE "course_purchase_orders" ADD CONSTRAINT "course_purchase_terms_acceptance" CHECK (("course_purchase_orders"."terms_accepted_at" is null and ("course_purchase_orders"."purchase_terms" is null or "course_purchase_orders"."status" = 'quoted')) or
      ("course_purchase_orders"."terms_accepted_at" is not null and "course_purchase_orders"."purchase_terms" is not null and "course_purchase_orders"."status" <> 'quoted'));