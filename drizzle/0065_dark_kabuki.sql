ALTER TABLE "product_shipment_jobs" DROP CONSTRAINT "product_shipment_jobs_funding_reservation_check";--> statement-breakpoint
DROP INDEX "product_shipment_jobs_active_funding_idx";--> statement-breakpoint
ALTER TABLE "product_shipment_jobs" DROP COLUMN "funding_attestation_id";--> statement-breakpoint
ALTER TABLE "product_shipment_jobs" DROP COLUMN "reserved_funding_cents";--> statement-breakpoint
ALTER TABLE "product_shipment_jobs" DROP COLUMN "funding_reservation_status";--> statement-breakpoint
ALTER TABLE "product_shipment_jobs" DROP COLUMN "funding_reserved_at";--> statement-breakpoint
ALTER TABLE "product_shipment_jobs" DROP COLUMN "funding_settled_at";--> statement-breakpoint
ALTER TABLE "product_shipment_jobs" DROP COLUMN "funding_released_at";