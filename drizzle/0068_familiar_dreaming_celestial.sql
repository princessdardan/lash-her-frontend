DROP INDEX "checkout_orders_helcim_purchase_transaction_idx";--> statement-breakpoint
DROP INDEX "order_payment_obligations_provider_invoice_idx";--> statement-breakpoint
ALTER TABLE "appointment_holds" ALTER COLUMN "payment_provider" SET DEFAULT 'square';--> statement-breakpoint
ALTER TABLE "checkout_orders" ALTER COLUMN "payment_provider" SET DEFAULT 'square';--> statement-breakpoint
ALTER TABLE "checkout_payment_events" ALTER COLUMN "payment_provider" SET DEFAULT 'square';--> statement-breakpoint
ALTER TABLE "order_payment_obligations" ALTER COLUMN "payment_provider" SET DEFAULT 'square';--> statement-breakpoint
ALTER TABLE "order_payment_transactions" ALTER COLUMN "provider" SET DEFAULT 'square';--> statement-breakpoint
ALTER TABLE "appointment_holds" DROP COLUMN "helcim_invoice_id";--> statement-breakpoint
ALTER TABLE "appointment_holds" DROP COLUMN "helcim_invoice_number";--> statement-breakpoint
ALTER TABLE "appointment_holds" DROP COLUMN "helcim_transaction_id";--> statement-breakpoint
ALTER TABLE "checkout_orders" DROP COLUMN "helcim_invoice_id";--> statement-breakpoint
ALTER TABLE "checkout_orders" DROP COLUMN "helcim_invoice_number";--> statement-breakpoint
ALTER TABLE "checkout_orders" DROP COLUMN "helcim_transaction_id";--> statement-breakpoint
ALTER TABLE "checkout_payment_events" DROP COLUMN "helcim_transaction_id";--> statement-breakpoint
ALTER TABLE "order_payment_obligations" DROP COLUMN "provider_invoice_id";--> statement-breakpoint
ALTER TABLE "order_payment_obligations" DROP COLUMN "provider_invoice_number";