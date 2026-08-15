INSERT INTO "fulfillment_data_quarantine" ("entity_type", "entity_id", "reason_code", "evidence")
SELECT
	'order_payment_obligation', obligation."id"::text,
	'legacy_primary_obligation_without_authoritative_transaction',
	jsonb_build_object(
		'obligation_id', obligation."id",
		'checkout_order_id', obligation."order_id",
		'payment_provider', obligation."payment_provider",
		'purpose', obligation."purpose",
		'status', obligation."status",
		'total_amount_cents', obligation."total_amount_cents",
		'currency', obligation."currency",
		'source_workflow', obligation."source_workflow",
		'provider_transaction_id_present', orders."helcim_transaction_id" IS NOT NULL,
		'created_at', obligation."created_at"
	)
FROM "order_payment_obligations" obligation
JOIN "checkout_orders" orders ON orders."id" = obligation."order_id"
WHERE obligation."purpose" = 'primary'
	AND obligation."source_workflow" = 'legacy_authoritative_backfill'
	AND NOT EXISTS (
		SELECT 1
		FROM "order_payment_transactions" transaction
		WHERE transaction."obligation_id" = obligation."id"
			AND transaction."provider" = obligation."payment_provider"
			AND transaction."provider_transaction_id" = CASE
				WHEN obligation."payment_provider" = 'helcim' THEN orders."helcim_transaction_id"
				ELSE orders."provider_payment_id"
			END
			AND transaction."provider_type" = 'purchase'
			AND transaction."amount_cents" = obligation."total_amount_cents"
			AND upper(transaction."currency") = upper(obligation."currency")
	)
ON CONFLICT ("entity_type", "entity_id", "reason_code") DO NOTHING;--> statement-breakpoint
UPDATE "order_payment_obligations" obligation
SET
	"status" = 'manual_review',
	"quarantined_at" = coalesce(obligation."quarantined_at", now()),
	"quarantine_reason" = coalesce(obligation."quarantine_reason", 'legacy_primary_obligation_without_authoritative_transaction'),
	"updated_at" = now()
WHERE obligation."purpose" = 'primary'
	AND obligation."source_workflow" = 'legacy_authoritative_backfill'
	AND EXISTS (
		SELECT 1 FROM "fulfillment_data_quarantine" quarantine
		WHERE quarantine."entity_type" = 'order_payment_obligation'
			AND quarantine."entity_id" = obligation."id"::text
			AND quarantine."reason_code" = 'legacy_primary_obligation_without_authoritative_transaction'
	);--> statement-breakpoint
INSERT INTO "fulfillment_data_quarantine" ("entity_type", "entity_id", "reason_code", "evidence")
SELECT
	'checkout_order', orders."id"::text,
	'legacy_primary_obligation_without_authoritative_transaction',
	jsonb_build_object(
		'checkout_order_id', orders."id",
		'payment_provider', orders."payment_provider",
		'status', orders."status",
		'purpose', orders."purpose",
		'amount_cents', orders."amount_cents",
		'currency', orders."currency",
		'created_at', orders."created_at",
		'paid_at', orders."paid_at"
	)
FROM "checkout_orders" orders
WHERE EXISTS (
	SELECT 1 FROM "order_payment_obligations" obligation
	WHERE obligation."order_id" = orders."id"
		AND obligation."purpose" = 'primary'
		AND obligation."source_workflow" = 'legacy_authoritative_backfill'
		AND obligation."quarantine_reason" = 'legacy_primary_obligation_without_authoritative_transaction'
)
ON CONFLICT ("entity_type", "entity_id", "reason_code") DO NOTHING;--> statement-breakpoint
UPDATE "checkout_orders" orders
SET
	"fulfillment_quarantined_at" = coalesce(orders."fulfillment_quarantined_at", now()),
	"fulfillment_quarantine_reason" = coalesce(orders."fulfillment_quarantine_reason", 'legacy_primary_obligation_without_authoritative_transaction'),
	"payment_risk_status" = 'review_required',
	"payment_risk_source" = 'migration_quarantine',
	"updated_at" = now()
WHERE EXISTS (
	SELECT 1 FROM "order_payment_obligations" obligation
	WHERE obligation."order_id" = orders."id"
		AND obligation."purpose" = 'primary'
		AND obligation."source_workflow" = 'legacy_authoritative_backfill'
		AND obligation."quarantine_reason" = 'legacy_primary_obligation_without_authoritative_transaction'
);--> statement-breakpoint
INSERT INTO "fulfillment_data_quarantine" ("entity_type", "entity_id", "reason_code", "evidence")
SELECT 'product_order_customer_decision', decision."id"::text, 'incomplete_operational_evidence_bundle',
	jsonb_build_object(
		'has_evidence_reference', decision."legal_follow_up_evidence_reference" IS NOT NULL,
		'has_rationale', decision."legal_follow_up_rationale" IS NOT NULL,
		'has_actor', decision."legal_follow_up_by_admin_user_id" IS NOT NULL,
		'has_step_up_at', decision."legal_follow_up_step_up_authenticated_at" IS NOT NULL,
		'has_recorded_at', decision."legal_follow_up_recorded_at" IS NOT NULL
	)
FROM "product_order_customer_decisions" decision
WHERE num_nonnulls(
	decision."legal_follow_up_evidence_reference", decision."legal_follow_up_rationale",
	decision."legal_follow_up_by_admin_user_id", decision."legal_follow_up_step_up_authenticated_at",
	decision."legal_follow_up_recorded_at"
) BETWEEN 1 AND 4
ON CONFLICT ("entity_type", "entity_id", "reason_code") DO NOTHING;--> statement-breakpoint
UPDATE "product_order_customer_decisions" decision
SET "legal_follow_up_evidence_reference" = NULL, "legal_follow_up_rationale" = NULL,
	"legal_follow_up_by_admin_user_id" = NULL, "legal_follow_up_step_up_authenticated_at" = NULL,
	"legal_follow_up_recorded_at" = NULL, "updated_at" = now()
WHERE num_nonnulls(
	decision."legal_follow_up_evidence_reference", decision."legal_follow_up_rationale",
	decision."legal_follow_up_by_admin_user_id", decision."legal_follow_up_step_up_authenticated_at",
	decision."legal_follow_up_recorded_at"
) BETWEEN 1 AND 4;--> statement-breakpoint
INSERT INTO "fulfillment_data_quarantine" ("entity_type", "entity_id", "reason_code", "evidence")
SELECT 'product_order_refund', refund."id"::text, 'incomplete_operational_evidence_bundle',
	jsonb_build_object(
		'has_evidence_reference', refund."manual_review_evidence_reference" IS NOT NULL,
		'has_rationale', refund."manual_review_rationale" IS NOT NULL,
		'has_actor', refund."manual_review_by_admin_user_id" IS NOT NULL,
		'has_step_up_at', refund."manual_review_step_up_authenticated_at" IS NOT NULL,
		'has_recorded_at', refund."manual_review_recorded_at" IS NOT NULL
	)
FROM "product_order_refunds" refund
WHERE num_nonnulls(
	refund."manual_review_evidence_reference", refund."manual_review_rationale",
	refund."manual_review_by_admin_user_id", refund."manual_review_step_up_authenticated_at",
	refund."manual_review_recorded_at"
) BETWEEN 1 AND 4
ON CONFLICT ("entity_type", "entity_id", "reason_code") DO NOTHING;--> statement-breakpoint
UPDATE "product_order_refunds" refund
SET "manual_review_evidence_reference" = NULL, "manual_review_rationale" = NULL,
	"manual_review_by_admin_user_id" = NULL, "manual_review_step_up_authenticated_at" = NULL,
	"manual_review_recorded_at" = NULL, "updated_at" = now()
WHERE num_nonnulls(
	refund."manual_review_evidence_reference", refund."manual_review_rationale",
	refund."manual_review_by_admin_user_id", refund."manual_review_step_up_authenticated_at",
	refund."manual_review_recorded_at"
) BETWEEN 1 AND 4;--> statement-breakpoint
INSERT INTO "fulfillment_data_quarantine" ("entity_type", "entity_id", "reason_code", "evidence")
SELECT 'product_shipment_job', job."id"::text, 'incomplete_operational_evidence_bundle',
	jsonb_build_object(
		'has_evidence_reference', job."reconciliation_evidence_reference" IS NOT NULL,
		'has_rationale', job."reconciliation_rationale" IS NOT NULL,
		'has_actor', job."reconciliation_requested_by_admin_user_id" IS NOT NULL,
		'has_step_up_at', job."reconciliation_step_up_authenticated_at" IS NOT NULL,
		'has_recorded_at', job."reconciliation_requested_at" IS NOT NULL
	)
FROM "product_shipment_jobs" job
WHERE num_nonnulls(
	job."reconciliation_evidence_reference", job."reconciliation_rationale",
	job."reconciliation_requested_by_admin_user_id", job."reconciliation_step_up_authenticated_at",
	job."reconciliation_requested_at"
) BETWEEN 1 AND 4
ON CONFLICT ("entity_type", "entity_id", "reason_code") DO NOTHING;--> statement-breakpoint
UPDATE "product_shipment_jobs" job
SET "reconciliation_evidence_reference" = NULL, "reconciliation_rationale" = NULL,
	"reconciliation_requested_by_admin_user_id" = NULL, "reconciliation_step_up_authenticated_at" = NULL,
	"reconciliation_requested_at" = NULL, "updated_at" = now()
WHERE num_nonnulls(
	job."reconciliation_evidence_reference", job."reconciliation_rationale",
	job."reconciliation_requested_by_admin_user_id", job."reconciliation_step_up_authenticated_at",
	job."reconciliation_requested_at"
) BETWEEN 1 AND 4;--> statement-breakpoint
INSERT INTO "fulfillment_data_quarantine" ("entity_type", "entity_id", "reason_code", "evidence")
SELECT 'product_shipment_return_observation', observation."id"::text, 'incomplete_operational_evidence_bundle',
	jsonb_build_object(
		'has_action', observation."admin_resolution_action" IS NOT NULL,
		'has_evidence_reference', observation."admin_resolution_evidence_reference" IS NOT NULL,
		'has_rationale', observation."admin_resolution_rationale" IS NOT NULL,
		'has_actor', observation."resolved_by_admin_user_id" IS NOT NULL,
		'has_step_up_at', observation."resolution_step_up_authenticated_at" IS NOT NULL,
		'has_resolved_at', observation."resolved_at" IS NOT NULL,
		'has_resolved_state_version', observation."resolved_state_version" IS NOT NULL
	)
FROM "product_shipment_return_observations" observation
WHERE num_nonnulls(
	observation."admin_resolution_action", observation."admin_resolution_evidence_reference",
	observation."admin_resolution_rationale", observation."resolved_by_admin_user_id",
	observation."resolution_step_up_authenticated_at", observation."resolved_at",
	observation."resolved_state_version"
) BETWEEN 1 AND 6
ON CONFLICT ("entity_type", "entity_id", "reason_code") DO NOTHING;--> statement-breakpoint
UPDATE "product_shipment_return_observations" observation
SET "admin_resolution_action" = NULL, "admin_resolution_evidence_reference" = NULL,
	"admin_resolution_rationale" = NULL, "resolved_by_admin_user_id" = NULL,
	"resolution_step_up_authenticated_at" = NULL, "resolved_at" = NULL,
	"resolved_state_version" = NULL, "updated_at" = now()
WHERE num_nonnulls(
	observation."admin_resolution_action", observation."admin_resolution_evidence_reference",
	observation."admin_resolution_rationale", observation."resolved_by_admin_user_id",
	observation."resolution_step_up_authenticated_at", observation."resolved_at",
	observation."resolved_state_version"
) BETWEEN 1 AND 6;--> statement-breakpoint
INSERT INTO "fulfillment_data_quarantine" ("entity_type", "entity_id", "reason_code", "evidence")
SELECT 'product_shipment', shipment."id"::text, 'incomplete_operational_evidence_bundle',
	jsonb_build_object(
		'has_evidence_reference', shipment."manual_review_evidence_reference" IS NOT NULL,
		'has_rationale', shipment."manual_review_rationale" IS NOT NULL,
		'has_actor', shipment."manual_review_by_admin_user_id" IS NOT NULL,
		'has_step_up_at', shipment."manual_review_step_up_authenticated_at" IS NOT NULL
	)
FROM "product_shipments" shipment
WHERE num_nonnulls(
	shipment."manual_review_evidence_reference", shipment."manual_review_rationale",
	shipment."manual_review_by_admin_user_id", shipment."manual_review_step_up_authenticated_at"
) BETWEEN 1 AND 3
ON CONFLICT ("entity_type", "entity_id", "reason_code") DO NOTHING;--> statement-breakpoint
UPDATE "product_shipments" shipment
SET "manual_review_evidence_reference" = NULL, "manual_review_rationale" = NULL,
	"manual_review_by_admin_user_id" = NULL, "manual_review_step_up_authenticated_at" = NULL,
	"updated_at" = now()
WHERE num_nonnulls(
	shipment."manual_review_evidence_reference", shipment."manual_review_rationale",
	shipment."manual_review_by_admin_user_id", shipment."manual_review_step_up_authenticated_at"
) BETWEEN 1 AND 3;--> statement-breakpoint
ALTER TABLE "product_order_customer_decisions" DROP CONSTRAINT "product_order_customer_decisions_legal_follow_up_evidence_check";--> statement-breakpoint
ALTER TABLE "product_order_refunds" DROP CONSTRAINT "product_order_refunds_manual_review_evidence_check";--> statement-breakpoint
ALTER TABLE "product_shipment_jobs" DROP CONSTRAINT "product_shipment_jobs_reconciliation_evidence_check";--> statement-breakpoint
ALTER TABLE "product_shipment_return_observations" DROP CONSTRAINT "product_shipment_returns_admin_resolution_check";--> statement-breakpoint
ALTER TABLE "product_shipments" DROP CONSTRAINT "product_shipments_manual_review_evidence_check";--> statement-breakpoint
ALTER TABLE "product_order_customer_decisions" ADD CONSTRAINT "product_order_customer_decisions_legal_follow_up_evidence_check" CHECK ((
        "product_order_customer_decisions"."legal_follow_up_evidence_reference" IS NULL
        AND "product_order_customer_decisions"."legal_follow_up_rationale" IS NULL
        AND "product_order_customer_decisions"."legal_follow_up_by_admin_user_id" IS NULL
        AND "product_order_customer_decisions"."legal_follow_up_step_up_authenticated_at" IS NULL
        AND "product_order_customer_decisions"."legal_follow_up_recorded_at" IS NULL
      ) OR (
        "product_order_customer_decisions"."legal_follow_up_evidence_reference" IS NOT NULL
        AND "product_order_customer_decisions"."legal_follow_up_rationale" IS NOT NULL
        AND "product_order_customer_decisions"."legal_follow_up_by_admin_user_id" IS NOT NULL
        AND "product_order_customer_decisions"."legal_follow_up_step_up_authenticated_at" IS NOT NULL
        AND "product_order_customer_decisions"."legal_follow_up_recorded_at" IS NOT NULL
        AND length(trim("product_order_customer_decisions"."legal_follow_up_evidence_reference")) >= 6
        AND length(trim("product_order_customer_decisions"."legal_follow_up_rationale")) >= 10
        AND "product_order_customer_decisions"."legal_follow_up_step_up_authenticated_at" <= "product_order_customer_decisions"."legal_follow_up_recorded_at"
        AND "product_order_customer_decisions"."legal_follow_up_step_up_authenticated_at" >= "product_order_customer_decisions"."legal_follow_up_recorded_at" - interval '5 minutes'
      ));--> statement-breakpoint
ALTER TABLE "product_order_refunds" ADD CONSTRAINT "product_order_refunds_manual_review_evidence_check" CHECK ((
        "product_order_refunds"."manual_review_evidence_reference" IS NULL
        AND "product_order_refunds"."manual_review_rationale" IS NULL
        AND "product_order_refunds"."manual_review_by_admin_user_id" IS NULL
        AND "product_order_refunds"."manual_review_step_up_authenticated_at" IS NULL
        AND "product_order_refunds"."manual_review_recorded_at" IS NULL
      ) OR (
        "product_order_refunds"."manual_review_evidence_reference" IS NOT NULL
        AND "product_order_refunds"."manual_review_rationale" IS NOT NULL
        AND "product_order_refunds"."manual_review_by_admin_user_id" IS NOT NULL
        AND "product_order_refunds"."manual_review_step_up_authenticated_at" IS NOT NULL
        AND "product_order_refunds"."manual_review_recorded_at" IS NOT NULL
        AND length(trim("product_order_refunds"."manual_review_evidence_reference")) >= 6
        AND length(trim("product_order_refunds"."manual_review_rationale")) >= 10
        AND "product_order_refunds"."manual_review_step_up_authenticated_at" <= "product_order_refunds"."manual_review_recorded_at"
        AND "product_order_refunds"."manual_review_step_up_authenticated_at" >= "product_order_refunds"."manual_review_recorded_at" - interval '5 minutes'
      ));--> statement-breakpoint
ALTER TABLE "product_shipment_jobs" ADD CONSTRAINT "product_shipment_jobs_reconciliation_evidence_check" CHECK ((
        "product_shipment_jobs"."reconciliation_evidence_reference" IS NULL
        AND "product_shipment_jobs"."reconciliation_rationale" IS NULL
        AND "product_shipment_jobs"."reconciliation_requested_by_admin_user_id" IS NULL
        AND "product_shipment_jobs"."reconciliation_step_up_authenticated_at" IS NULL
        AND "product_shipment_jobs"."reconciliation_requested_at" IS NULL
      ) OR (
        "product_shipment_jobs"."reconciliation_evidence_reference" IS NOT NULL
        AND "product_shipment_jobs"."reconciliation_rationale" IS NOT NULL
        AND "product_shipment_jobs"."reconciliation_requested_by_admin_user_id" IS NOT NULL
        AND "product_shipment_jobs"."reconciliation_step_up_authenticated_at" IS NOT NULL
        AND "product_shipment_jobs"."reconciliation_requested_at" IS NOT NULL
        AND length(trim("product_shipment_jobs"."reconciliation_evidence_reference")) >= 6
        AND length(trim("product_shipment_jobs"."reconciliation_rationale")) >= 10
        AND "product_shipment_jobs"."reconciliation_step_up_authenticated_at" <= "product_shipment_jobs"."reconciliation_requested_at"
        AND "product_shipment_jobs"."reconciliation_step_up_authenticated_at" >= "product_shipment_jobs"."reconciliation_requested_at" - interval '5 minutes'
      ));--> statement-breakpoint
ALTER TABLE "product_shipment_return_observations" ADD CONSTRAINT "product_shipment_returns_admin_resolution_check" CHECK ((
        "product_shipment_return_observations"."admin_resolution_action" IS NULL
        AND "product_shipment_return_observations"."admin_resolution_evidence_reference" IS NULL
        AND "product_shipment_return_observations"."admin_resolution_rationale" IS NULL
        AND "product_shipment_return_observations"."resolved_by_admin_user_id" IS NULL
        AND "product_shipment_return_observations"."resolution_step_up_authenticated_at" IS NULL
        AND "product_shipment_return_observations"."resolved_at" IS NULL
        AND "product_shipment_return_observations"."resolved_state_version" IS NULL
      ) OR (
        "product_shipment_return_observations"."admin_resolution_action" IS NOT NULL
        AND "product_shipment_return_observations"."admin_resolution_evidence_reference" IS NOT NULL
        AND "product_shipment_return_observations"."admin_resolution_rationale" IS NOT NULL
        AND "product_shipment_return_observations"."resolved_by_admin_user_id" IS NOT NULL
        AND "product_shipment_return_observations"."resolution_step_up_authenticated_at" IS NOT NULL
        AND "product_shipment_return_observations"."resolved_at" IS NOT NULL
        AND "product_shipment_return_observations"."resolved_state_version" IS NOT NULL
        AND "product_shipment_return_observations"."admin_resolution_action" IN ('record_inspection', 'escalate_unmatched_return', 'confirm_linked_case')
        AND length(trim("product_shipment_return_observations"."admin_resolution_evidence_reference")) >= 6
        AND length(trim("product_shipment_return_observations"."admin_resolution_rationale")) >= 10
        AND "product_shipment_return_observations"."resolution_step_up_authenticated_at" <= "product_shipment_return_observations"."resolved_at"
        AND "product_shipment_return_observations"."resolution_step_up_authenticated_at" >= "product_shipment_return_observations"."resolved_at" - interval '5 minutes'
        AND "product_shipment_return_observations"."resolved_state_version" >= 2
        AND "product_shipment_return_observations"."resolved_state_version" <= "product_shipment_return_observations"."state_version"
      ));--> statement-breakpoint
ALTER TABLE "product_shipments" ADD CONSTRAINT "product_shipments_manual_review_evidence_check" CHECK ((
        "product_shipments"."manual_review_evidence_reference" IS NULL
        AND "product_shipments"."manual_review_rationale" IS NULL
        AND "product_shipments"."manual_review_by_admin_user_id" IS NULL
        AND "product_shipments"."manual_review_step_up_authenticated_at" IS NULL
      ) OR (
        "product_shipments"."manual_review_evidence_reference" IS NOT NULL
        AND "product_shipments"."manual_review_rationale" IS NOT NULL
        AND "product_shipments"."manual_review_by_admin_user_id" IS NOT NULL
        AND "product_shipments"."manual_review_step_up_authenticated_at" IS NOT NULL
        AND "product_shipments"."manual_review_acknowledged_at" IS NOT NULL
        AND length(trim("product_shipments"."manual_review_evidence_reference")) >= 6
        AND length(trim("product_shipments"."manual_review_rationale")) >= 10
        AND "product_shipments"."manual_review_step_up_authenticated_at" <= "product_shipments"."manual_review_acknowledged_at"
        AND "product_shipments"."manual_review_step_up_authenticated_at" >= "product_shipments"."manual_review_acknowledged_at" - interval '5 minutes'
      ));
