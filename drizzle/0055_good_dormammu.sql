ALTER TABLE "checkout_orders" ADD COLUMN "privacy_terminal_at" timestamp with time zone;--> statement-breakpoint
CREATE FUNCTION "protect_checkout_order_privacy_terminal_at"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF OLD."privacy_terminal_at" IS NOT NULL
		AND NEW."privacy_terminal_at" IS DISTINCT FROM OLD."privacy_terminal_at" THEN
		RAISE EXCEPTION 'checkout order privacy_terminal_at is immutable once set';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "checkout_orders_privacy_terminal_at_immutable"
BEFORE UPDATE OF "privacy_terminal_at" ON "checkout_orders"
FOR EACH ROW
EXECUTE FUNCTION "protect_checkout_order_privacy_terminal_at"();
