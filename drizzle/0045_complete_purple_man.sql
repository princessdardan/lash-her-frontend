CREATE TABLE "fulfillment_risk_alert_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"incident_key" text NOT NULL,
	"recipient_duty" "shipping_policy_duty" DEFAULT 'payment_fraud_owner' NOT NULL,
	"payload" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"last_error" text,
	"redaction_due_at" timestamp with time zone DEFAULT now() + interval '365 days' NOT NULL,
	"redacted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fulfillment_risk_alert_outbox_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "fulfillment_risk_alert_outbox_status_check" CHECK ("fulfillment_risk_alert_outbox"."status" IN ('queued', 'sending', 'sent', 'dead_letter'))
);
--> statement-breakpoint
ALTER TABLE "fulfillment_risk_alert_outbox" ADD CONSTRAINT "fulfillment_risk_alert_outbox_incident_id_product_payment_risk_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."product_payment_risk_incidents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fulfillment_risk_alert_outbox_claim_idx" ON "fulfillment_risk_alert_outbox" USING btree ("status","available_at","lease_expires_at");