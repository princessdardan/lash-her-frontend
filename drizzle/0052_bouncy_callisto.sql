CREATE TABLE "shipping_policy_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"task_key" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"state_version" integer DEFAULT 1 NOT NULL,
	"payload" jsonb,
	"outcome_code" text,
	"last_error" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipping_policy_jobs_task_key_unique" UNIQUE("task_key"),
	CONSTRAINT "shipping_policy_jobs_type_check" CHECK ("shipping_policy_jobs"."type" IN ('deadlines', 'decisions', 'remedies', 'refunds', 'returns', 'claims', 'funding', 'calendar', 'privacy', 'notifications')),
	CONSTRAINT "shipping_policy_jobs_status_check" CHECK ("shipping_policy_jobs"."status" IN ('queued', 'processing', 'succeeded', 'retryable_failure', 'manual_review'))
);
--> statement-breakpoint
ALTER TABLE "product_order_customer_decisions" ADD COLUMN "proposed_conditions_hash" text;--> statement-breakpoint
UPDATE "product_order_customer_decisions"
SET "proposed_conditions_hash" = md5("scope_key" || E'\n' || coalesce("proposed_conditions"::text, 'null'))
WHERE "proposed_conditions_hash" IS NULL;--> statement-breakpoint
ALTER TABLE "product_order_customer_decisions" ALTER COLUMN "proposed_conditions_hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "product_order_customer_decisions" ADD CONSTRAINT "product_order_customer_decisions_conditions_hash_check" CHECK ("proposed_conditions_hash" ~ '^[0-9a-f]{32}([0-9a-f]{32})?$');--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_customer_decision_condition_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.redacted_at IS NULL
     AND NEW.redacted_at IS NULL
     AND (
       NEW.scope_key IS DISTINCT FROM OLD.scope_key
       OR NEW.proposed_conditions IS DISTINCT FROM OLD.proposed_conditions
       OR NEW.proposed_conditions_hash IS DISTINCT FROM OLD.proposed_conditions_hash
     ) THEN
    RAISE EXCEPTION 'customer decision scope and proposed conditions are immutable';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER product_order_customer_decisions_conditions_immutable
BEFORE UPDATE ON "product_order_customer_decisions"
FOR EACH ROW
EXECUTE FUNCTION prevent_customer_decision_condition_mutation();--> statement-breakpoint
CREATE INDEX "shipping_policy_jobs_claim_idx" ON "shipping_policy_jobs" USING btree ("status","available_at","lease_expires_at");
