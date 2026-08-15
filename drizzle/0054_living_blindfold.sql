INSERT INTO "fulfillment_data_quarantine" (
	"entity_type",
	"entity_id",
	"reason_code",
	"evidence"
)
SELECT
	'fulfillment_provider_certification',
	c."id"::text,
	'helcim_contract_snapshot_unverifiable',
	jsonb_build_object(
		'certification_id', c."id",
		'provider', c."provider",
		'environment', c."environment",
		'scope', c."scope",
		'version', c."version",
		'certified_at', c."certified_at",
		'valid_until', c."valid_until",
		'created_at', c."created_at",
		'contract_snapshot_present', false
	)
FROM "fulfillment_provider_certifications" c
WHERE c."provider" = 'helcim'
	AND c."scope" = 'product_payments'
	AND c."revoked_at" IS NULL
	AND c."contract_snapshot" IS NULL
ON CONFLICT ("entity_type", "entity_id", "reason_code") DO NOTHING;--> statement-breakpoint
UPDATE "fulfillment_provider_certifications" c
SET "revoked_at" = GREATEST(now(), c."certified_at")
WHERE c."provider" = 'helcim'
	AND c."scope" = 'product_payments'
	AND c."revoked_at" IS NULL
	AND c."contract_snapshot" IS NULL;--> statement-breakpoint
ALTER TABLE "fulfillment_provider_certifications"
	ADD CONSTRAINT "fulfillment_provider_certifications_helcim_contract_snapshot_check"
	CHECK (
		"provider" <> 'helcim'
		OR "scope" <> 'product_payments'
		OR "revoked_at" IS NOT NULL
		OR "contract_snapshot" IS NOT NULL
	) NOT VALID;--> statement-breakpoint
ALTER TABLE "fulfillment_provider_certifications"
	VALIDATE CONSTRAINT "fulfillment_provider_certifications_helcim_contract_snapshot_check";
