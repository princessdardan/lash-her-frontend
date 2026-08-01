DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "booking_service_offerings"
		WHERE "status" = 'active'
		GROUP BY "service_id", "provider_id"
		HAVING count(*) > 1
	) THEN
		RAISE EXCEPTION 'Migration 0026 cannot enforce one active offering per service and provider because duplicate active rows exist. Disable or archive all but one offering in each duplicate service_id/provider_id pair, then rerun the migration.';
	END IF;
END
$$;
--> statement-breakpoint
CREATE UNIQUE INDEX "booking_service_offerings_active_service_provider_idx" ON "booking_service_offerings" USING btree ("service_id","provider_id") WHERE "booking_service_offerings"."status" = 'active';
