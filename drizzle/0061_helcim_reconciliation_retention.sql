-- Remove legacy free-text reconciliation evidence from records that do not
-- participate in the private-data retention lifecycle. New reconciliation
-- evidence is stored in fulfillment_owner_actions with the obligation's
-- pii_redaction_due_at deadline.
UPDATE "admin_audit_logs"
SET "metadata" = jsonb_strip_nulls(jsonb_build_object(
  'legacyReconciliationEvidenceRedacted', true,
  'expectedStateVersion', "metadata" -> 'expectedStateVersion',
  'nextStateVersion', "metadata" -> 'nextStateVersion'
))
WHERE "action" LIKE 'payment_obligation.initialization.%'
  AND (
    "metadata" ? 'evidenceReference'
    OR "metadata" ? 'rationale'
    OR "metadata" ? 'providerInvoiceNumber'
  );

UPDATE "order_payment_obligations"
SET "initialization_last_error" = 'owner_reconciliation_legacy_evidence_redacted'
WHERE "initialization_last_error" LIKE 'owner_reconciliation:%';

UPDATE "order_payment_obligations"
SET "initialization_last_error" = NULL
WHERE "redacted_at" IS NOT NULL
  AND "initialization_last_error" IS NOT NULL;
