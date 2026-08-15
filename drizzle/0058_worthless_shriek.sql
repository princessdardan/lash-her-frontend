INSERT INTO "fulfillment_data_quarantine" (
	"entity_type", "entity_id", "reason_code", "evidence"
)
SELECT
	'fulfillment_provider_certification',
	certification."id"::text,
	'duplicate_active_provider_certification_scope',
	jsonb_build_object(
		'certification_id', certification."id",
		'provider', certification."provider",
		'environment', certification."environment",
		'scope', certification."scope",
		'version', certification."version",
		'certified_at', certification."certified_at",
		'valid_until', certification."valid_until",
		'created_at', certification."created_at",
		'active_scope_count', duplicate_scope."active_scope_count"
	)
FROM "fulfillment_provider_certifications" certification
INNER JOIN (
	SELECT
		"provider", "environment", "scope", count(*) AS "active_scope_count"
	FROM "fulfillment_provider_certifications"
	WHERE "revoked_at" IS NULL
	GROUP BY "provider", "environment", "scope"
	HAVING count(*) > 1
) duplicate_scope
	ON duplicate_scope."provider" = certification."provider"
	AND duplicate_scope."environment" = certification."environment"
	AND duplicate_scope."scope" = certification."scope"
WHERE certification."revoked_at" IS NULL
ON CONFLICT ("entity_type", "entity_id", "reason_code") DO NOTHING;--> statement-breakpoint
UPDATE "fulfillment_provider_certifications" certification
SET "revoked_at" = GREATEST(now(), certification."certified_at")
WHERE certification."revoked_at" IS NULL
	AND EXISTS (
		SELECT 1
		FROM "fulfillment_data_quarantine" quarantine
		WHERE quarantine."entity_type" = 'fulfillment_provider_certification'
			AND quarantine."entity_id" = certification."id"::text
			AND quarantine."reason_code" = 'duplicate_active_provider_certification_scope'
	);--> statement-breakpoint
DROP INDEX "fulfillment_provider_certifications_identity_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "fulfillment_provider_certifications_one_active_scope_idx" ON "fulfillment_provider_certifications" USING btree ("provider","environment","scope") WHERE "fulfillment_provider_certifications"."revoked_at" IS NULL;
