CREATE TABLE "square_payment_refund_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_event_id" text NOT NULL,
	"square_refund_id" text NOT NULL,
	"square_payment_id" text NOT NULL,
	"status" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"payload_sanitized" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "square_payment_refund_events_amount_check" CHECK ("square_payment_refund_events"."amount_cents" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "square_payment_refund_events_provider_event_idx" ON "square_payment_refund_events" USING btree ("provider_event_id");--> statement-breakpoint
CREATE INDEX "square_payment_refund_events_refund_occurred_idx" ON "square_payment_refund_events" USING btree ("square_refund_id","occurred_at");--> statement-breakpoint
CREATE INDEX "square_payment_refund_events_payment_status_occurred_idx" ON "square_payment_refund_events" USING btree ("square_payment_id","status","occurred_at");