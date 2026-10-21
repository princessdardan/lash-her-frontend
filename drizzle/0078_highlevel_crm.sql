CREATE TABLE "highlevel_connections" (
	"location_id" text PRIMARY KEY NOT NULL,
	"credentials_ciphertext" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"refresh_state" text DEFAULT 'ready' NOT NULL,
	"installed_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "highlevel_consent_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"origin_key" text NOT NULL,
	"email_normalized" text NOT NULL,
	"channel" text NOT NULL,
	"destination" text NOT NULL,
	"choice" text NOT NULL,
	"consent_text" text,
	"consent_version" text,
	"source" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "highlevel_consent_events_origin_key_unique" UNIQUE("origin_key")
);
--> statement-breakpoint
CREATE TABLE "highlevel_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" text NOT NULL,
	"email_normalized" text NOT NULL,
	"phone" text,
	"provider_id" text,
	"deleted_at" timestamp with time zone,
	"provider_email_blocked" boolean DEFAULT false NOT NULL,
	"provider_sms_blocked" boolean DEFAULT false NOT NULL,
	"provider_updated_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "highlevel_effects" (
	"key" text PRIMARY KEY NOT NULL,
	"contact_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"provider_id" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "highlevel_oauth_states" (
	"hash" text PRIMARY KEY NOT NULL,
	"actor_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "highlevel_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_key" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"event_type" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"historical" boolean DEFAULT false NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_by" text,
	"locked_until" timestamp with time zone,
	"last_error" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "highlevel_outbox_event_key_unique" UNIQUE("event_key")
);
--> statement-breakpoint
CREATE TABLE "highlevel_webhook_receipts" (
	"key" text PRIMARY KEY NOT NULL,
	"location_id" text NOT NULL,
	"event_type" text NOT NULL,
	"provider_contact_id" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "highlevel_effects" ADD CONSTRAINT "highlevel_effects_contact_id_highlevel_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."highlevel_contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "highlevel_consent_identity_idx" ON "highlevel_consent_events" USING btree ("email_normalized","channel","destination","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "highlevel_contacts_email_idx" ON "highlevel_contacts" USING btree ("location_id","email_normalized");--> statement-breakpoint
CREATE UNIQUE INDEX "highlevel_contacts_provider_idx" ON "highlevel_contacts" USING btree ("location_id","provider_id");--> statement-breakpoint
CREATE INDEX "highlevel_outbox_due_idx" ON "highlevel_outbox" USING btree ("status","next_run_at");--> statement-breakpoint
CREATE INDEX "highlevel_outbox_entity_idx" ON "highlevel_outbox" USING btree ("entity_type","entity_id");
-- Capture reference-only CRM events in the originating transaction. No provider
-- calls or duplicate PII snapshots are made in a trigger. Disabled workers retain
-- the events, so a later cutover does not lose website activity.
--> statement-breakpoint
ALTER TABLE highlevel_consent_events ADD CONSTRAINT highlevel_consent_channel_check CHECK (channel IN ('email','sms'));
--> statement-breakpoint
ALTER TABLE highlevel_consent_events ADD CONSTRAINT highlevel_consent_choice_check CHECK (choice IN ('opted_in','not_opted_in','unsubscribed'));
--> statement-breakpoint
ALTER TABLE highlevel_outbox ADD CONSTRAINT highlevel_outbox_status_check CHECK (status IN ('queued','processing','retry','review','dead_letter','succeeded','skipped'));
--> statement-breakpoint
CREATE FUNCTION highlevel_capture_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_row jsonb;
  previous_row jsonb;
  changed boolean := TG_OP <> 'UPDATE';
  field_name text;
  entity_id_value text;
BEGIN
  current_row := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  IF TG_OP = 'UPDATE' THEN
    previous_row := to_jsonb(OLD);
    FOREACH field_name IN ARRAY string_to_array(TG_ARGV[2], ',') LOOP
      IF current_row->field_name IS DISTINCT FROM previous_row->field_name THEN changed := true; END IF;
    END LOOP;
  END IF;
  IF changed THEN
    entity_id_value := current_row->>TG_ARGV[1];
    IF entity_id_value IS NULL THEN RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END; END IF;
    INSERT INTO highlevel_outbox (event_key, entity_type, entity_id, event_type, historical)
    VALUES ('capture:' || gen_random_uuid()::text, TG_ARGV[0], entity_id_value, TG_TABLE_NAME || ':' || lower(TG_OP),
      coalesce(current_setting('highlevel.historical', true) = 'true', false)
      OR coalesce(current_row->>'source_system' NOT IN ('website'), false));
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
--> statement-breakpoint
CREATE TRIGGER highlevel_submission_capture AFTER INSERT OR UPDATE OR DELETE ON marketing_contact_submissions FOR EACH ROW EXECUTE FUNCTION highlevel_capture_event('submission','id','email,name,phone,payload');
--> statement-breakpoint
CREATE TRIGGER highlevel_order_capture AFTER INSERT OR UPDATE OR DELETE ON checkout_orders FOR EACH ROW EXECUTE FUNCTION highlevel_capture_event('order','id','status,customer_email,customer_name,amount_cents,manual_fulfillment_status,redacted_at,deleted_at');
--> statement-breakpoint
CREATE TRIGGER highlevel_enrollment_capture AFTER INSERT OR UPDATE OR DELETE ON training_enrollments FOR EACH ROW EXECUTE FUNCTION highlevel_capture_event('enrollment','id','scheduling_status,checkout_email');
--> statement-breakpoint
CREATE TRIGGER highlevel_refund_capture AFTER INSERT OR UPDATE ON product_order_refunds FOR EACH ROW EXECUTE FUNCTION highlevel_capture_event('order','order_id','status');
--> statement-breakpoint
CREATE TRIGGER highlevel_shipment_capture AFTER INSERT OR UPDATE ON product_shipments FOR EACH ROW EXECUTE FUNCTION highlevel_capture_event('order','order_id','status');
--> statement-breakpoint
CREATE TRIGGER highlevel_channel_consent_capture AFTER INSERT ON highlevel_consent_events FOR EACH ROW EXECUTE FUNCTION highlevel_capture_event('consent','id','choice');
--> statement-breakpoint
CREATE FUNCTION highlevel_mirror_email_consent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO highlevel_consent_events (origin_key, email_normalized, channel, destination, choice, consent_text, consent_version, source, occurred_at)
  VALUES ('email:' || NEW.id::text, NEW.email_normalized, 'email', NEW.email_normalized,
    CASE WHEN NEW.event_type IN ('opt_in','backfill_consent') THEN 'opted_in' WHEN NEW.event_type = 'unsubscribe' THEN 'unsubscribed' ELSE 'not_opted_in' END,
    NEW.consent_text, coalesce(NEW.metadata->>'consentVersion','legacy-email'), NEW.source, NEW.occurred_at)
  ON CONFLICT (origin_key) DO NOTHING;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER highlevel_email_consent_capture AFTER INSERT ON marketing_consent_events FOR EACH ROW EXECUTE FUNCTION highlevel_mirror_email_consent();
