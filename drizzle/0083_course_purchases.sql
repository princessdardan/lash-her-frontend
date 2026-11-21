CREATE TABLE "course_purchase_job_replays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" text NOT NULL,
	"admin_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "course_purchase_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"refund_id" text,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease" uuid,
	"lease_until" timestamp with time zone,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_failure" text,
	"destination_receipt" text,
	CONSTRAINT "course_purchase_job_kind" CHECK ("course_purchase_jobs"."kind" in ('grant','revoke','tax_sale','tax_refund','receipt')),
	CONSTRAINT "course_purchase_job_status" CHECK ("course_purchase_jobs"."status" in ('pending','processing','done','dead','canceled')),
	CONSTRAINT "course_purchase_job_lease" CHECK (("course_purchase_jobs"."status" = 'processing' and "course_purchase_jobs"."lease" is not null and "course_purchase_jobs"."lease_until" is not null) or
    ("course_purchase_jobs"."status" <> 'processing' and "course_purchase_jobs"."lease" is null and "course_purchase_jobs"."lease_until" is null))
);
--> statement-breakpoint
CREATE TABLE "course_purchase_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"course_revision" integer NOT NULL,
	"course_slug" text NOT NULL,
	"course_title" text NOT NULL,
	"tax_classification" text NOT NULL,
	"email" text NOT NULL,
	"billing" jsonb NOT NULL,
	"policy_hash" text NOT NULL,
	"policy_version" text NOT NULL,
	"disclosure" text NOT NULL,
	"tax_code" text NOT NULL,
	"tax_behavior" text NOT NULL,
	"tax_breakdown" jsonb NOT NULL,
	"price_cents" integer NOT NULL,
	"tax_cents" integer NOT NULL,
	"total_cents" integer NOT NULL,
	"tax_calculation" text NOT NULL,
	"quote_expires_at" timestamp with time zone NOT NULL,
	"square_location_id" text NOT NULL,
	"status" text DEFAULT 'quoted' NOT NULL,
	"access" text DEFAULT 'none' NOT NULL,
	"source_fingerprint" text,
	"square_payment_id" text,
	"charged_at" timestamp with time zone,
	"refunded_cents" integer DEFAULT 0 NOT NULL,
	"tax_transaction_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_purchase_order_status" CHECK ("course_purchase_orders"."status" in ('quoted','charging','paid','failed','refunded')),
	CONSTRAINT "course_purchase_access_status" CHECK ("course_purchase_orders"."access" in ('none','pending','active','revocation_pending','revoked')),
	CONSTRAINT "course_purchase_amounts" CHECK ("course_purchase_orders"."price_cents" > 0 and "course_purchase_orders"."tax_cents" >= 0 and
    (("course_purchase_orders"."tax_behavior" = 'exclusive' and "course_purchase_orders"."total_cents"::bigint = "course_purchase_orders"."price_cents"::bigint + "course_purchase_orders"."tax_cents") or
      ("course_purchase_orders"."tax_behavior" = 'inclusive' and "course_purchase_orders"."total_cents" = "course_purchase_orders"."price_cents" and "course_purchase_orders"."tax_cents" <= "course_purchase_orders"."price_cents"))
    and "course_purchase_orders"."refunded_cents" between 0 and "course_purchase_orders"."total_cents")
);
--> statement-breakpoint
CREATE TABLE "course_purchase_refunds" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"confirmed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "course_purchase_refund_amount" CHECK ("course_purchase_refunds"."amount_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "course_purchase_job_replays" ADD CONSTRAINT "course_purchase_job_replays_job_id_course_purchase_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."course_purchase_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_purchase_jobs" ADD CONSTRAINT "course_purchase_jobs_order_id_course_purchase_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."course_purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_purchase_jobs" ADD CONSTRAINT "course_purchase_jobs_refund_id_course_purchase_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."course_purchase_refunds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_purchase_orders" ADD CONSTRAINT "course_purchase_orders_customer_id_customer_users_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_purchase_refunds" ADD CONSTRAINT "course_purchase_refunds_order_id_course_purchase_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."course_purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "course_purchase_jobs_ready" ON "course_purchase_jobs" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "course_purchase_jobs_order" ON "course_purchase_jobs" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "course_purchase_live_customer_course" ON "course_purchase_orders" USING btree ("customer_id","course_id") WHERE "course_purchase_orders"."status" in ('charging', 'paid');--> statement-breakpoint
CREATE UNIQUE INDEX "course_purchase_square_payment" ON "course_purchase_orders" USING btree ("square_payment_id");--> statement-breakpoint
CREATE INDEX "course_purchase_refund_order" ON "course_purchase_refunds" USING btree ("order_id");