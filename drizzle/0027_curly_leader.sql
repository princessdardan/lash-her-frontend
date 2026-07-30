CREATE TABLE "booking_service_promotion_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"internal_title" text NOT NULL,
	"discount_type" text NOT NULL,
	"discount_value" integer NOT NULL,
	"status" "booking_configuration_status" DEFAULT 'draft' NOT NULL,
	"source_sanity_document_id" text,
	"effective_from" timestamp with time zone,
	"effective_until" timestamp with time zone,
	"created_by_admin_user_id" uuid,
	"updated_by_admin_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_service_promotion_codes_code_check" CHECK ("booking_service_promotion_codes"."code" ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'),
	CONSTRAINT "booking_service_promotion_codes_discount_type_check" CHECK ("booking_service_promotion_codes"."discount_type" IN ('percentage', 'fixed')),
	CONSTRAINT "booking_service_promotion_codes_discount_value_check" CHECK ("booking_service_promotion_codes"."discount_value" > 0 AND ("booking_service_promotion_codes"."discount_type" <> 'percentage' OR "booking_service_promotion_codes"."discount_value" <= 10000)),
	CONSTRAINT "booking_service_promotion_codes_effective_range_check" CHECK ("booking_service_promotion_codes"."effective_until" IS NULL OR "booking_service_promotion_codes"."effective_from" IS NULL OR "booking_service_promotion_codes"."effective_until" > "booking_service_promotion_codes"."effective_from")
);
--> statement-breakpoint
CREATE TABLE "booking_service_promotion_offerings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"promotion_code_id" uuid NOT NULL,
	"offering_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "booking_business_settings" ADD COLUMN "intake_questions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_business_settings" ADD COLUMN "marketing_opt_in_label" text DEFAULT 'I agree to receive occasional updates from Lash Her by Nataliea.' NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_service_promotion_codes" ADD CONSTRAINT "booking_service_promotion_codes_created_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("created_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_service_promotion_codes" ADD CONSTRAINT "booking_service_promotion_codes_updated_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("updated_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_service_promotion_offerings" ADD CONSTRAINT "booking_service_promotion_offerings_promotion_code_id_booking_service_promotion_codes_id_fk" FOREIGN KEY ("promotion_code_id") REFERENCES "public"."booking_service_promotion_codes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_service_promotion_offerings" ADD CONSTRAINT "booking_service_promotion_offerings_offering_id_booking_service_offerings_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."booking_service_offerings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "booking_service_promotion_codes_code_idx" ON "booking_service_promotion_codes" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_service_promotion_codes_sanity_document_idx" ON "booking_service_promotion_codes" USING btree ("source_sanity_document_id");--> statement-breakpoint
CREATE INDEX "booking_service_promotion_codes_status_window_idx" ON "booking_service_promotion_codes" USING btree ("status","effective_from","effective_until");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_service_promotion_offerings_pair_idx" ON "booking_service_promotion_offerings" USING btree ("promotion_code_id","offering_id");--> statement-breakpoint
CREATE INDEX "booking_service_promotion_offerings_offering_idx" ON "booking_service_promotion_offerings" USING btree ("offering_id","promotion_code_id");
