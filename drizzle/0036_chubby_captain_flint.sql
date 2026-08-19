CREATE TABLE "fulfillment_owner_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"action" text NOT NULL,
	"admin_user_id" uuid NOT NULL,
	"policy_version" text NOT NULL,
	"rationale" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"step_up_authenticated_at" timestamp with time zone NOT NULL,
	"cooling_off_until" timestamp with time zone NOT NULL,
	"executed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fulfillment_owner_actions_rationale_check" CHECK (length(trim("fulfillment_owner_actions"."rationale")) >= 10)
);
--> statement-breakpoint
ALTER TABLE "product_payment_risk_incidents" ADD COLUMN "incident_key" text;--> statement-breakpoint
UPDATE "product_payment_risk_incidents"
SET "incident_key" = 'legacy/' || "id"::text
WHERE "incident_key" IS NULL;--> statement-breakpoint
ALTER TABLE "product_payment_risk_incidents" ALTER COLUMN "incident_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "shipping_package_profiles" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shipping_package_profiles" ADD COLUMN "reviewed_by_admin_user_id" uuid;--> statement-breakpoint
ALTER TABLE "shipping_package_profiles" ADD COLUMN "evidence_reference" text;--> statement-breakpoint
ALTER TABLE "fulfillment_owner_actions" ADD CONSTRAINT "fulfillment_owner_actions_admin_user_id_admin_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fulfillment_owner_actions_target_idx" ON "fulfillment_owner_actions" USING btree ("target_type","target_id","created_at");--> statement-breakpoint
ALTER TABLE "shipping_package_profiles" ADD CONSTRAINT "shipping_package_profiles_reviewed_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("reviewed_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_payment_risk_incidents" ADD CONSTRAINT "product_payment_risk_incidents_incident_key_unique" UNIQUE("incident_key");
