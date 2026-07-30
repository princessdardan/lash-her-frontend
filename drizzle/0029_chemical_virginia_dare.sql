DROP INDEX "booking_services_service_key_idx";--> statement-breakpoint
DROP INDEX "booking_services_sanity_document_idx";--> statement-breakpoint
DROP INDEX "booking_services_public_slug_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "booking_services_service_key_idx" ON "booking_services" USING btree ("owner_provider_id","service_key");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_services_sanity_document_idx" ON "booking_services" USING btree ("owner_provider_id","sanity_document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_services_public_slug_idx" ON "booking_services" USING btree ("owner_provider_id","public_slug");