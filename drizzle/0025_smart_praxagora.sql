ALTER TABLE "booking_service_offerings" ADD COLUMN "public_title" text;--> statement-breakpoint
ALTER TABLE "booking_service_offerings" ADD COLUMN "public_summary" text;--> statement-breakpoint
ALTER TABLE "booking_services" ADD COLUMN "owner_provider_id" uuid;--> statement-breakpoint
ALTER TABLE "booking_services" ADD CONSTRAINT "booking_services_owner_provider_id_booking_providers_id_fk" FOREIGN KEY ("owner_provider_id") REFERENCES "public"."booking_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "booking_services_owner_provider_idx" ON "booking_services" USING btree ("owner_provider_id");--> statement-breakpoint
WITH "service_provider_resolution" AS (
	SELECT
		"service_id",
		CASE
			WHEN count(DISTINCT "provider_id") = 1
				THEN min("provider_id"::text)::uuid
			ELSE NULL
		END AS "owner_provider_id"
	FROM "booking_service_offerings"
	GROUP BY "service_id"
)
UPDATE "booking_services" AS "service"
SET
	"owner_provider_id" = "resolution"."owner_provider_id",
	"updated_at" = now()
FROM "service_provider_resolution" AS "resolution"
WHERE
	"resolution"."service_id" = "service"."id"
	AND "service"."owner_provider_id" IS DISTINCT FROM "resolution"."owner_provider_id";--> statement-breakpoint
UPDATE "booking_service_offerings" AS "offering"
SET
	"public_title" = CASE
		WHEN "offering"."public_title" IS NULL OR btrim("offering"."public_title") = ''
			THEN left(btrim("service"."display_title"), 160)
		ELSE "offering"."public_title"
	END,
	"public_summary" = CASE
		WHEN "offering"."public_summary" IS NULL OR btrim("offering"."public_summary") = ''
			THEN left(
				'Book ' || btrim("service"."display_title") || ' with ' || btrim("provider"."display_name") || '.',
				500
			)
		ELSE "offering"."public_summary"
	END,
	"updated_at" = now()
FROM
	"booking_services" AS "service",
	"booking_providers" AS "provider"
WHERE
	"service"."id" = "offering"."service_id"
	AND "provider"."id" = "offering"."provider_id"
	AND (
		"offering"."public_title" IS NULL
		OR btrim("offering"."public_title") = ''
		OR "offering"."public_summary" IS NULL
		OR btrim("offering"."public_summary") = ''
	);
