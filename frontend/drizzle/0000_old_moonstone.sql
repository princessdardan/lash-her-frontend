CREATE TYPE "public"."checkout_order_status" AS ENUM('pending', 'paid', 'verification_failed', 'cancelled', 'refunded');--> statement-breakpoint
CREATE TABLE "checkout_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" text NOT NULL,
	"status" "checkout_order_status" DEFAULT 'pending' NOT NULL,
	"checkout_token_hash" text NOT NULL,
	"secret_token_ciphertext" text NOT NULL,
	"helcim_invoice_id" integer NOT NULL,
	"helcim_invoice_number" text NOT NULL,
	"helcim_transaction_id" text,
	"customer_name" text NOT NULL,
	"customer_email" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'CAD' NOT NULL,
	"line_items" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"redacted_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "checkout_orders_order_id_unique" UNIQUE("order_id"),
	CONSTRAINT "checkout_orders_checkout_token_hash_unique" UNIQUE("checkout_token_hash")
);
--> statement-breakpoint
CREATE TABLE "checkout_payment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid,
	"event_type" text NOT NULL,
	"helcim_transaction_id" text,
	"status" text,
	"amount_cents" integer,
	"currency" text,
	"message" text,
	"idempotency_key" text,
	"payload_redacted" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checkout_payment_events_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "checkout_payment_events" ADD CONSTRAINT "checkout_payment_events_order_id_checkout_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."checkout_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "checkout_orders_checkout_token_hash_idx" ON "checkout_orders" USING btree ("checkout_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "checkout_payment_events_idempotency_key_idx" ON "checkout_payment_events" USING btree ("idempotency_key");