ALTER TABLE "booking_no_show_charge_attempts" DROP CONSTRAINT "booking_no_show_charge_attempts_idempotency_key_unique";--> statement-breakpoint
ALTER TABLE "booking_no_show_charge_attempts" DROP CONSTRAINT "booking_no_show_charge_attempts_square_payment_id_unique";--> statement-breakpoint
ALTER TABLE "booking_no_show_charge_records" DROP CONSTRAINT "booking_no_show_charge_records_square_invoice_id_unique";--> statement-breakpoint
ALTER TABLE "booking_no_show_charge_records" DROP CONSTRAINT "booking_no_show_charge_records_square_order_id_unique";--> statement-breakpoint
ALTER TABLE "booking_no_show_charge_records" DROP CONSTRAINT "booking_no_show_charge_records_square_payment_id_unique";--> statement-breakpoint
ALTER TABLE "booking_saved_payment_methods" DROP CONSTRAINT "booking_saved_payment_methods_square_card_id_unique";--> statement-breakpoint
ALTER TABLE "booking_square_customers" DROP CONSTRAINT "booking_square_customers_email_normalized_unique";--> statement-breakpoint
ALTER TABLE "booking_square_customers" DROP CONSTRAINT "booking_square_customers_square_customer_id_unique";