CREATE FUNCTION "protect_chitchats_intake_location_attestation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'Chit Chats intake-location attestations cannot be deleted';
	END IF;

	IF NEW."id" IS DISTINCT FROM OLD."id"
		OR NEW."provider_environment" IS DISTINCT FROM OLD."provider_environment"
		OR NEW."provider_client_id" IS DISTINCT FROM OLD."provider_client_id"
		OR NEW."region" IS DISTINCT FROM OLD."region"
		OR NEW."location_name" IS DISTINCT FROM OLD."location_name"
		OR NEW."location_address" IS DISTINCT FROM OLD."location_address"
		OR NEW."location_type" IS DISTINCT FROM OLD."location_type"
		OR NEW."evidence_reference" IS DISTINCT FROM OLD."evidence_reference"
		OR NEW."rationale" IS DISTINCT FROM OLD."rationale"
		OR NEW."statement_version" IS DISTINCT FROM OLD."statement_version"
		OR NEW."policy_version" IS DISTINCT FROM OLD."policy_version"
		OR NEW."attested_by_admin_user_id" IS DISTINCT FROM OLD."attested_by_admin_user_id"
		OR NEW."attested_by_owner_name" IS DISTINCT FROM OLD."attested_by_owner_name"
		OR NEW."step_up_authenticated_at" IS DISTINCT FROM OLD."step_up_authenticated_at"
		OR NEW."attested_at" IS DISTINCT FROM OLD."attested_at"
		OR NEW."valid_until" IS DISTINCT FROM OLD."valid_until"
		OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
		RAISE EXCEPTION 'Chit Chats intake-location attestation evidence is immutable';
	END IF;

	IF OLD."revoked_at" IS NULL
		AND OLD."revoked_by_admin_user_id" IS NULL
		AND OLD."revocation_reason" IS NULL
		AND NEW."revoked_at" IS NOT NULL
		AND NEW."revoked_by_admin_user_id" IS NOT NULL
		AND NEW."revocation_reason" IS NOT NULL THEN
		RETURN NEW;
	END IF;

	RAISE EXCEPTION 'Chit Chats intake-location attestation revocation is one-way';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "chitchats_intake_location_attestation_immutable"
BEFORE UPDATE OR DELETE ON "chitchats_intake_location_attestations"
FOR EACH ROW
EXECUTE FUNCTION "protect_chitchats_intake_location_attestation"();
