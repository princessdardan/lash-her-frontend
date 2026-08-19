CREATE TABLE "shipping_customer_link_issuances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"target_id" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipping_customer_link_issuances_kind_check" CHECK ("shipping_customer_link_issuances"."kind" IN ('address_change', 'customer_decision', 'supplemental_payment'))
);
--> statement-breakpoint
ALTER TABLE "shipping_package_profiles" DROP CONSTRAINT "shipping_package_profiles_reviewed_by_admin_user_id_admin_users_id_fk";
--> statement-breakpoint
ALTER TABLE "fulfillment_provider_certifications" ADD COLUMN "certified_by_admin_user_id" uuid;--> statement-breakpoint
ALTER TABLE "fulfillment_provider_certifications" ADD COLUMN "certification_step_up_authenticated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fulfillment_provider_certifications" ADD COLUMN "certification_evidence_hash" text;--> statement-breakpoint
ALTER TABLE "fulfillment_provider_certifications" ADD COLUMN "certification_evidence_version" text;--> statement-breakpoint
ALTER TABLE "fulfillment_provider_certifications" ADD COLUMN "certification_action" text;--> statement-breakpoint
ALTER TABLE "product_tax_policy_versions" ADD COLUMN "approved_by_admin_user_id" uuid;--> statement-breakpoint
ALTER TABLE "product_tax_policy_versions" ADD COLUMN "approval_step_up_authenticated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_tax_policy_versions" ADD COLUMN "approval_evidence_hash" text;--> statement-breakpoint
ALTER TABLE "product_tax_policy_versions" ADD COLUMN "approval_evidence_version" text;--> statement-breakpoint
ALTER TABLE "product_tax_policy_versions" ADD COLUMN "approval_action" text;--> statement-breakpoint
ALTER TABLE "product_tax_policy_versions" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shipping_package_profiles" ADD COLUMN "review_step_up_authenticated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shipping_package_profiles" ADD COLUMN "review_evidence_hash" text;--> statement-breakpoint
ALTER TABLE "shipping_package_profiles" ADD COLUMN "review_evidence_version" text;--> statement-breakpoint
ALTER TABLE "shipping_package_profiles" ADD COLUMN "review_action" text;--> statement-breakpoint
ALTER TABLE "shipping_service_policies" ADD COLUMN "reviewed_by_admin_user_id" uuid;--> statement-breakpoint
ALTER TABLE "shipping_service_policies" ADD COLUMN "review_step_up_authenticated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shipping_service_policies" ADD COLUMN "evidence_reference" text;--> statement-breakpoint
ALTER TABLE "shipping_service_policies" ADD COLUMN "review_evidence_hash" text;--> statement-breakpoint
ALTER TABLE "shipping_service_policies" ADD COLUMN "review_evidence_version" text;--> statement-breakpoint
ALTER TABLE "shipping_service_policies" ADD COLUMN "review_action" text;--> statement-breakpoint
ALTER TABLE "shipping_customer_link_issuances" ADD CONSTRAINT "shipping_customer_link_issuances_order_id_checkout_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."checkout_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shipping_customer_link_issuances_order_idx" ON "shipping_customer_link_issuances" USING btree ("order_id","issued_at");--> statement-breakpoint
CREATE UNIQUE INDEX "shipping_customer_link_issuances_target_idx" ON "shipping_customer_link_issuances" USING btree ("kind","target_id");--> statement-breakpoint
ALTER TABLE "fulfillment_provider_certifications" ADD CONSTRAINT "fulfillment_provider_certifications_certified_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("certified_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_tax_policy_versions" ADD CONSTRAINT "product_tax_policy_versions_approved_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("approved_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_package_profiles" ADD CONSTRAINT "shipping_package_profiles_reviewed_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("reviewed_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_service_policies" ADD CONSTRAINT "shipping_service_policies_reviewed_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("reviewed_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
INSERT INTO "fulfillment_data_quarantine" ("entity_type", "entity_id", "reason_code", "evidence")
SELECT
	'product_tax_policy_version',
	p."id"::text,
	'effective_tax_policy_owner_evidence_unverifiable',
	jsonb_build_object(
		'policy_id', p."id",
		'version', p."version",
		'status', p."status",
		'approved_at', p."approved_at",
		'effective_at', p."effective_at",
		'created_at', p."created_at"
	)
FROM "product_tax_policy_versions" p
WHERE p."status" = 'effective'
	AND (
		p."approved_by_admin_user_id" IS NULL
		OR p."approval_step_up_authenticated_at" IS NULL
		OR p."approved_at" IS NULL
		OR p."approval_step_up_authenticated_at" > p."approved_at"
		OR p."approval_step_up_authenticated_at" < p."approved_at" - interval '5 minutes'
		OR p."effective_at" IS NULL
		OR p."effective_at" < p."approved_at"
		OR p."superseded_at" IS NOT NULL
		OR length(trim(p."evidence_reference")) = 0
		OR p."approval_evidence_hash" IS NULL
		OR p."approval_evidence_hash" !~ '^[0-9a-f]{64}$'
		OR p."approval_evidence_version" IS NULL
		OR length(trim(p."approval_evidence_version")) = 0
		OR p."approval_action" IS DISTINCT FROM 'approve_product_tax_policy'
		OR NOT (p."coverage" @> '{"merchandise":true,"shipping":true,"supplements":true,"usOrders":true,"componentRefunds":true}'::jsonb)
	)
ON CONFLICT ("entity_type", "entity_id", "reason_code") DO NOTHING;--> statement-breakpoint
UPDATE "product_tax_policy_versions" p
SET "status" = 'draft', "effective_at" = NULL, "superseded_at" = NULL
WHERE p."status" = 'effective'
	AND EXISTS (
		SELECT 1 FROM "fulfillment_data_quarantine" q
		WHERE q."entity_type" = 'product_tax_policy_version'
			AND q."entity_id" = p."id"::text
			AND q."reason_code" = 'effective_tax_policy_owner_evidence_unverifiable'
	);--> statement-breakpoint
INSERT INTO "fulfillment_data_quarantine" ("entity_type", "entity_id", "reason_code", "evidence")
SELECT
	'shipping_package_profile',
	p."id"::text,
	'enabled_package_profile_owner_evidence_unverifiable',
	jsonb_build_object(
		'package_profile_id', p."id",
		'slug', p."slug",
		'enabled', p."enabled",
		'rank', p."rank",
		'package_type', p."package_type",
		'reviewed_at', p."reviewed_at",
		'created_at', p."created_at",
		'updated_at', p."updated_at"
	)
FROM "shipping_package_profiles" p
WHERE p."enabled" = true
	AND (
		p."reviewed_at" IS NULL
		OR p."reviewed_by_admin_user_id" IS NULL
		OR p."review_step_up_authenticated_at" IS NULL
		OR p."review_step_up_authenticated_at" > p."reviewed_at"
		OR p."review_step_up_authenticated_at" < p."reviewed_at" - interval '5 minutes'
		OR p."evidence_reference" IS NULL
		OR length(trim(p."evidence_reference")) = 0
		OR p."review_evidence_hash" IS NULL
		OR p."review_evidence_hash" !~ '^[0-9a-f]{64}$'
		OR p."review_evidence_version" IS NULL
		OR length(trim(p."review_evidence_version")) = 0
		OR p."review_action" IS DISTINCT FROM 'approve_shipping_package_profile'
	)
ON CONFLICT ("entity_type", "entity_id", "reason_code") DO NOTHING;--> statement-breakpoint
UPDATE "shipping_package_profiles" p
SET "enabled" = false, "updated_at" = now()
WHERE p."enabled" = true
	AND EXISTS (
		SELECT 1 FROM "fulfillment_data_quarantine" q
		WHERE q."entity_type" = 'shipping_package_profile'
			AND q."entity_id" = p."id"::text
			AND q."reason_code" = 'enabled_package_profile_owner_evidence_unverifiable'
	);--> statement-breakpoint
INSERT INTO "fulfillment_data_quarantine" ("entity_type", "entity_id", "reason_code", "evidence")
SELECT
	'shipping_service_policy',
	p."id"::text,
	'enabled_service_policy_owner_evidence_unverifiable',
	jsonb_build_object(
		'service_policy_id', p."id",
		'postage_type', p."postage_type",
		'destination_country_code', p."destination_country_code",
		'enabled', p."enabled",
		'reviewed_at', p."reviewed_at",
		'created_at', p."created_at",
		'updated_at', p."updated_at"
	)
FROM "shipping_service_policies" p
WHERE p."enabled" = true
	AND (
		p."reviewed_by_admin_user_id" IS NULL
		OR p."review_step_up_authenticated_at" IS NULL
		OR p."review_step_up_authenticated_at" > p."reviewed_at"
		OR p."review_step_up_authenticated_at" < p."reviewed_at" - interval '5 minutes'
		OR p."evidence_reference" IS NULL
		OR length(trim(p."evidence_reference")) = 0
		OR p."review_evidence_hash" IS NULL
		OR p."review_evidence_hash" !~ '^[0-9a-f]{64}$'
		OR p."review_evidence_version" IS NULL
		OR length(trim(p."review_evidence_version")) = 0
		OR p."review_action" IS DISTINCT FROM 'approve_shipping_service_policy'
	)
ON CONFLICT ("entity_type", "entity_id", "reason_code") DO NOTHING;--> statement-breakpoint
UPDATE "shipping_service_policies" p
SET "enabled" = false, "updated_at" = now()
WHERE p."enabled" = true
	AND EXISTS (
		SELECT 1 FROM "fulfillment_data_quarantine" q
		WHERE q."entity_type" = 'shipping_service_policy'
			AND q."entity_id" = p."id"::text
			AND q."reason_code" = 'enabled_service_policy_owner_evidence_unverifiable'
	);--> statement-breakpoint
INSERT INTO "fulfillment_data_quarantine" ("entity_type", "entity_id", "reason_code", "evidence")
SELECT
	'fulfillment_provider_certification',
	c."id"::text,
	'active_provider_certification_owner_evidence_unverifiable',
	jsonb_build_object(
		'certification_id', c."id",
		'provider', c."provider",
		'environment', c."environment",
		'scope', c."scope",
		'version', c."version",
		'certified_at', c."certified_at",
		'valid_until', c."valid_until",
		'created_at', c."created_at"
	)
FROM "fulfillment_provider_certifications" c
WHERE c."revoked_at" IS NULL
	AND (
		c."certified_by_admin_user_id" IS NULL
		OR c."certification_step_up_authenticated_at" IS NULL
		OR c."certification_step_up_authenticated_at" > c."certified_at"
		OR c."certification_step_up_authenticated_at" < c."certified_at" - interval '5 minutes'
		OR c."certification_evidence_hash" IS NULL
		OR c."certification_evidence_hash" !~ '^[0-9a-f]{64}$'
		OR c."certification_evidence_version" IS NULL
		OR length(trim(c."certification_evidence_version")) = 0
		OR c."certification_action" IS DISTINCT FROM 'certify_fulfillment_provider'
	)
ON CONFLICT ("entity_type", "entity_id", "reason_code") DO NOTHING;--> statement-breakpoint
UPDATE "fulfillment_provider_certifications" c
SET "revoked_at" = GREATEST(now(), c."certified_at")
WHERE c."revoked_at" IS NULL
	AND EXISTS (
		SELECT 1 FROM "fulfillment_data_quarantine" q
		WHERE q."entity_type" = 'fulfillment_provider_certification'
			AND q."entity_id" = c."id"::text
			AND q."reason_code" = 'active_provider_certification_owner_evidence_unverifiable'
	);--> statement-breakpoint
CREATE UNIQUE INDEX "product_tax_policy_versions_one_effective_idx" ON "product_tax_policy_versions" USING btree ("status") WHERE "product_tax_policy_versions"."status" = 'effective';--> statement-breakpoint
ALTER TABLE "fulfillment_provider_certifications" ADD CONSTRAINT "fulfillment_provider_certifications_active_owner_evidence_check" CHECK ("fulfillment_provider_certifications"."revoked_at" IS NOT NULL OR ("fulfillment_provider_certifications"."certified_by_admin_user_id" IS NOT NULL AND "fulfillment_provider_certifications"."certification_step_up_authenticated_at" IS NOT NULL AND "fulfillment_provider_certifications"."certification_step_up_authenticated_at" <= "fulfillment_provider_certifications"."certified_at" AND "fulfillment_provider_certifications"."certification_step_up_authenticated_at" >= "fulfillment_provider_certifications"."certified_at" - interval '5 minutes' AND "fulfillment_provider_certifications"."certification_evidence_hash" ~ '^[0-9a-f]{64}$' AND length(trim("fulfillment_provider_certifications"."certification_evidence_version")) > 0 AND "fulfillment_provider_certifications"."certification_action" = 'certify_fulfillment_provider'));--> statement-breakpoint
ALTER TABLE "product_tax_policy_versions" ADD CONSTRAINT "product_tax_policy_versions_status_check" CHECK ("product_tax_policy_versions"."status" IN ('draft', 'effective', 'superseded'));--> statement-breakpoint
ALTER TABLE "product_tax_policy_versions" ADD CONSTRAINT "product_tax_policy_versions_effective_evidence_check" CHECK ("product_tax_policy_versions"."status" <> 'effective' OR ("product_tax_policy_versions"."approved_by_admin_user_id" IS NOT NULL AND "product_tax_policy_versions"."approval_step_up_authenticated_at" IS NOT NULL AND "product_tax_policy_versions"."approved_at" IS NOT NULL AND "product_tax_policy_versions"."approval_step_up_authenticated_at" <= "product_tax_policy_versions"."approved_at" AND "product_tax_policy_versions"."approval_step_up_authenticated_at" >= "product_tax_policy_versions"."approved_at" - interval '5 minutes' AND "product_tax_policy_versions"."effective_at" IS NOT NULL AND "product_tax_policy_versions"."effective_at" >= "product_tax_policy_versions"."approved_at" AND "product_tax_policy_versions"."superseded_at" IS NULL AND length(trim("product_tax_policy_versions"."evidence_reference")) > 0 AND "product_tax_policy_versions"."approval_evidence_hash" ~ '^[0-9a-f]{64}$' AND length(trim("product_tax_policy_versions"."approval_evidence_version")) > 0 AND "product_tax_policy_versions"."approval_action" = 'approve_product_tax_policy' AND "product_tax_policy_versions"."coverage" @> '{"merchandise":true,"shipping":true,"supplements":true,"usOrders":true,"componentRefunds":true}'::jsonb));--> statement-breakpoint
ALTER TABLE "shipping_package_profiles" ADD CONSTRAINT "shipping_package_profiles_enabled_evidence_check" CHECK ("shipping_package_profiles"."enabled" = false OR ("shipping_package_profiles"."reviewed_at" IS NOT NULL AND "shipping_package_profiles"."reviewed_by_admin_user_id" IS NOT NULL AND "shipping_package_profiles"."review_step_up_authenticated_at" IS NOT NULL AND "shipping_package_profiles"."review_step_up_authenticated_at" <= "shipping_package_profiles"."reviewed_at" AND "shipping_package_profiles"."review_step_up_authenticated_at" >= "shipping_package_profiles"."reviewed_at" - interval '5 minutes' AND length(trim("shipping_package_profiles"."evidence_reference")) > 0 AND "shipping_package_profiles"."review_evidence_hash" ~ '^[0-9a-f]{64}$' AND length(trim("shipping_package_profiles"."review_evidence_version")) > 0 AND "shipping_package_profiles"."review_action" = 'approve_shipping_package_profile'));--> statement-breakpoint
ALTER TABLE "shipping_service_policies" ADD CONSTRAINT "shipping_service_policies_enabled_evidence_check" CHECK ("shipping_service_policies"."enabled" = false OR ("shipping_service_policies"."reviewed_by_admin_user_id" IS NOT NULL AND "shipping_service_policies"."review_step_up_authenticated_at" IS NOT NULL AND "shipping_service_policies"."review_step_up_authenticated_at" <= "shipping_service_policies"."reviewed_at" AND "shipping_service_policies"."review_step_up_authenticated_at" >= "shipping_service_policies"."reviewed_at" - interval '5 minutes' AND length(trim("shipping_service_policies"."evidence_reference")) > 0 AND "shipping_service_policies"."review_evidence_hash" ~ '^[0-9a-f]{64}$' AND length(trim("shipping_service_policies"."review_evidence_version")) > 0 AND "shipping_service_policies"."review_action" = 'approve_shipping_service_policy'));
