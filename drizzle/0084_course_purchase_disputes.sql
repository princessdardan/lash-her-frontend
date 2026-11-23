CREATE TABLE "course_purchase_disputes" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"state" text NOT NULL,
	"version" integer,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "course_purchase_dispute_amount" CHECK ("course_purchase_disputes"."amount_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "course_purchase_jobs" ADD COLUMN "access_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "course_purchase_jobs" ADD COLUMN "revoke_reason" text;--> statement-breakpoint
ALTER TABLE "course_purchase_orders" ADD COLUMN "dispute_blocked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "course_purchase_orders" ADD COLUMN "dispute_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "course_purchase_orders" ADD COLUMN "access_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "course_purchase_disputes" ADD CONSTRAINT "course_purchase_disputes_order_id_course_purchase_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."course_purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "course_purchase_disputes_order" ON "course_purchase_disputes" USING btree ("order_id");--> statement-breakpoint
ALTER TABLE "course_purchase_jobs" ADD CONSTRAINT "course_purchase_job_revoke_reason" CHECK ("course_purchase_jobs"."revoke_reason" is null or
        ("course_purchase_jobs"."kind" = 'revoke' and "course_purchase_jobs"."revoke_reason" in ('refund', 'dispute')));