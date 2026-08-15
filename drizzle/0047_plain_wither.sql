ALTER TABLE "manual_fulfillment_policy_versions" DROP CONSTRAINT "manual_fulfillment_policy_versions_effective_evidence_check";--> statement-breakpoint
ALTER TABLE "manual_fulfillment_policy_versions" ADD COLUMN "policy_text_hash" text;--> statement-breakpoint
ALTER TABLE "product_shipments" ADD COLUMN "us_shipping_contract_snapshot" jsonb;--> statement-breakpoint
UPDATE "manual_fulfillment_policy_versions"
SET "status" = 'draft', "effective_at" = NULL
WHERE "status" = 'effective'
	AND (
		"policy_text_hash" IS NULL
		OR "policy_text_hash" !~ '^[0-9a-f]{64}$'
		OR "approved_at" IS NULL
		OR "approved_by_admin_user_id" IS NULL
		OR "evidence_reference" IS NULL
		OR length(trim("evidence_reference")) = 0
		OR jsonb_typeof("policy_snapshot" -> 'cancellationPolicyText') <> 'string'
		OR length(trim("policy_snapshot" ->> 'cancellationPolicyText')) = 0
	);--> statement-breakpoint
ALTER TABLE "manual_fulfillment_policy_versions" ADD CONSTRAINT "manual_fulfillment_policy_versions_effective_evidence_check" CHECK ("manual_fulfillment_policy_versions"."status" <> 'effective' OR ("manual_fulfillment_policy_versions"."effective_at" IS NOT NULL AND "manual_fulfillment_policy_versions"."approved_at" IS NOT NULL AND "manual_fulfillment_policy_versions"."effective_at" >= "manual_fulfillment_policy_versions"."approved_at" AND "manual_fulfillment_policy_versions"."approved_by_admin_user_id" IS NOT NULL AND "manual_fulfillment_policy_versions"."policy_text_hash" ~ '^[0-9a-f]{64}$' AND length(trim("manual_fulfillment_policy_versions"."evidence_reference")) > 0 AND jsonb_typeof("manual_fulfillment_policy_versions"."policy_snapshot" -> 'cancellationPolicyText') = 'string' AND length(trim("manual_fulfillment_policy_versions"."policy_snapshot" ->> 'cancellationPolicyText')) > 0 AND "manual_fulfillment_policy_versions"."superseded_at" IS NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "manual_fulfillment_policy_versions" VALIDATE CONSTRAINT "manual_fulfillment_policy_versions_effective_evidence_check";--> statement-breakpoint
CREATE FUNCTION "prevent_product_shipment_us_contract_snapshot_replacement"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF OLD."us_shipping_contract_snapshot" IS NOT NULL
		AND NEW."us_shipping_contract_snapshot" IS DISTINCT FROM OLD."us_shipping_contract_snapshot" THEN
		RAISE EXCEPTION 'shipment US shipping contract snapshots cannot be replaced';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "product_shipment_us_contract_snapshot_immutable"
BEFORE UPDATE OF "us_shipping_contract_snapshot" ON "product_shipments"
FOR EACH ROW
EXECUTE FUNCTION "prevent_product_shipment_us_contract_snapshot_replacement"();
