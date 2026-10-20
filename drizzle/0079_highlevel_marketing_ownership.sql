ALTER TABLE "customer_email_outbox" ADD COLUMN "delivery_provider" text DEFAULT 'resend' NOT NULL;
--> statement-breakpoint
ALTER TABLE customer_email_outbox ADD CONSTRAINT highlevel_delivery_provider_check CHECK (delivery_provider IN ('resend','highlevel') AND (delivery_provider = 'resend' OR kind = 'contact_popup_offer'));
--> statement-breakpoint
CREATE FUNCTION highlevel_capture_offer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.delivery_provider = 'highlevel' THEN
    INSERT INTO highlevel_outbox (event_key, entity_type, entity_id, event_type)
    VALUES ('offer:' || NEW.id::text, 'delivery', NEW.id::text, 'welcome_offer_requested') ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER highlevel_offer_capture AFTER INSERT ON customer_email_outbox FOR EACH ROW EXECUTE FUNCTION highlevel_capture_offer();
