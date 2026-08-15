DROP INDEX IF EXISTS "product_order_refunds_provider_refund_id_idx";--> statement-breakpoint
ALTER TABLE "checkout_orders" ADD COLUMN "us_import_disclosure_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "fulfillment_provider_certifications" ADD COLUMN "contract_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "product_order_refunds" ADD COLUMN IF NOT EXISTS "fulfillment_quarantined_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_order_refunds" ADD COLUMN IF NOT EXISTS "fulfillment_quarantine_reason" text;--> statement-breakpoint
ALTER TABLE "product_shipments" ADD COLUMN "intake_location_attestation_id" uuid;--> statement-breakpoint
ALTER TABLE "product_shipments" ADD CONSTRAINT "product_shipments_intake_location_attestation_id_chitchats_intake_location_attestations_id_fk" FOREIGN KEY ("intake_location_attestation_id") REFERENCES "public"."chitchats_intake_location_attestations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_order_refunds_provider_refund_id_idx" ON "product_order_refunds" USING btree ("provider_refund_id") WHERE "product_order_refunds"."provider_refund_id" IS NOT NULL AND "product_order_refunds"."fulfillment_quarantined_at" IS NULL;--> statement-breakpoint
ALTER TABLE "fulfillment_provider_certifications" ADD CONSTRAINT "fulfillment_provider_certifications_us_contract_snapshot_check" CHECK ("fulfillment_provider_certifications"."scope" <> 'us_shipping_contract' OR "fulfillment_provider_certifications"."contract_snapshot" IS NOT NULL);--> statement-breakpoint
CREATE FUNCTION "prevent_fulfillment_provider_contract_snapshot_update"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW."contract_snapshot" IS DISTINCT FROM OLD."contract_snapshot" THEN
		RAISE EXCEPTION 'fulfillment provider certification contract snapshots are immutable';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "fulfillment_provider_contract_snapshot_immutable"
BEFORE UPDATE OF "contract_snapshot" ON "fulfillment_provider_certifications"
FOR EACH ROW
EXECUTE FUNCTION "prevent_fulfillment_provider_contract_snapshot_update"();
