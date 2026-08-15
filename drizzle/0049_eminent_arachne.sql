ALTER TABLE "product_payment_risk_incidents" ADD COLUMN "state_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "product_shipment_jobs" ADD COLUMN "funding_attestation_id" uuid;--> statement-breakpoint
ALTER TABLE "product_shipment_jobs" ADD COLUMN "reserved_funding_cents" integer;--> statement-breakpoint
ALTER TABLE "product_shipment_jobs" ADD COLUMN "funding_reservation_status" text;--> statement-breakpoint
ALTER TABLE "product_shipment_jobs" ADD COLUMN "funding_reserved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_shipment_jobs" ADD COLUMN "funding_settled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_shipment_jobs" ADD COLUMN "funding_released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_shipment_jobs" ADD CONSTRAINT "product_shipment_jobs_funding_attestation_id_shipping_funding_reviews_id_fk" FOREIGN KEY ("funding_attestation_id") REFERENCES "public"."shipping_funding_reviews"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_shipment_jobs_active_funding_idx" ON "product_shipment_jobs" USING btree ("funding_attestation_id","funding_reservation_status") WHERE "product_shipment_jobs"."funding_reservation_status" = 'reserved';--> statement-breakpoint
ALTER TABLE "product_shipment_jobs" ADD CONSTRAINT "product_shipment_jobs_funding_reservation_check" CHECK ((
        "product_shipment_jobs"."funding_reservation_status" IS NULL
        AND "product_shipment_jobs"."funding_attestation_id" IS NULL
        AND "product_shipment_jobs"."reserved_funding_cents" IS NULL
        AND "product_shipment_jobs"."funding_reserved_at" IS NULL
        AND "product_shipment_jobs"."funding_settled_at" IS NULL
        AND "product_shipment_jobs"."funding_released_at" IS NULL
      ) OR (
        "product_shipment_jobs"."funding_reservation_status" IN ('reserved', 'settled', 'released')
        AND "product_shipment_jobs"."funding_attestation_id" IS NOT NULL
        AND "product_shipment_jobs"."reserved_funding_cents" > 0
        AND "product_shipment_jobs"."funding_reserved_at" IS NOT NULL
        AND (
          ("product_shipment_jobs"."funding_reservation_status" = 'reserved' AND "product_shipment_jobs"."funding_settled_at" IS NULL AND "product_shipment_jobs"."funding_released_at" IS NULL)
          OR ("product_shipment_jobs"."funding_reservation_status" = 'settled' AND "product_shipment_jobs"."funding_settled_at" IS NOT NULL AND "product_shipment_jobs"."funding_released_at" IS NULL)
          OR ("product_shipment_jobs"."funding_reservation_status" = 'released' AND "product_shipment_jobs"."funding_settled_at" IS NULL AND "product_shipment_jobs"."funding_released_at" IS NOT NULL)
        )
      ));