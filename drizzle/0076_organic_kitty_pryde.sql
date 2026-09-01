ALTER TABLE "customer_email_outbox" DROP CONSTRAINT "customer_email_outbox_active_customer_order_link_check";--> statement-breakpoint
ALTER TABLE "customer_email_outbox" ADD COLUMN "submission_id" uuid;--> statement-breakpoint
ALTER TABLE "customer_email_outbox" ADD COLUMN "recipient_email_normalized" text;--> statement-breakpoint
ALTER TABLE "customer_email_outbox" ADD CONSTRAINT "customer_email_outbox_submission_id_marketing_contact_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."marketing_contact_submissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_email_outbox_submission_id_idx" ON "customer_email_outbox" USING btree ("submission_id");--> statement-breakpoint
DROP TRIGGER "customer_email_outbox_order_retention_trigger" ON "customer_email_outbox";--> statement-breakpoint
CREATE OR REPLACE FUNCTION "enforce_customer_email_outbox_order_retention"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  order_redaction_due_at timestamptz;
  order_purpose text;
  order_redacted_at timestamptz;
  submission_type text;
  submission_consent_choice text;
  submission_email_normalized text;
  submission_submitted_at timestamptz;
BEGIN
  IF NEW."redacted_at" IS NOT NULL THEN
    NEW."recipient_email_normalized" := NULL;
  END IF;

  IF NEW."kind" = 'contact_popup_offer' AND NEW."redacted_at" IS NULL THEN
    IF NEW."submission_id" IS NULL THEN
      RAISE EXCEPTION 'active contact popup offer email requires a submission link';
    END IF;
    IF NEW."recipient_email_normalized" IS NULL
       OR length(trim(NEW."recipient_email_normalized")) = 0 THEN
      RAISE EXCEPTION 'active contact popup offer email requires a recipient';
    END IF;
    SELECT submissions."submission_type"::text,
           submissions."consent_choice",
           submissions."email_normalized",
           submissions."submitted_at"
      INTO submission_type, submission_consent_choice, submission_email_normalized, submission_submitted_at
      FROM "marketing_contact_submissions" submissions
     WHERE submissions."id" = NEW."submission_id";
    IF submission_type IS NULL THEN
      RAISE EXCEPTION 'contact popup offer email submission link is invalid';
    END IF;
    IF submission_type <> 'contact_popup'
       OR submission_consent_choice <> 'opted_in' THEN
      RAISE EXCEPTION 'contact popup offer email requires an opted-in contact popup submission';
    END IF;
    IF lower(trim(submission_email_normalized)) <> NEW."recipient_email_normalized" THEN
      RAISE EXCEPTION 'contact popup offer email recipient does not match submission';
    END IF;
    IF NEW."redaction_due_at" > submission_submitted_at + interval '395 days' THEN
      RAISE EXCEPTION 'contact popup offer email retention exceeds submission retention';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."kind" NOT IN ('shipping_policy_alert', 'contact_popup_offer')
     AND NEW."redacted_at" IS NULL
     AND NEW."order_id" IS NULL THEN
    RAISE EXCEPTION 'active customer email requires an order link';
  END IF;
  IF NEW."order_id" IS NOT NULL THEN
    SELECT orders."pii_redaction_due_at", orders."purpose", orders."redacted_at"
      INTO order_redaction_due_at, order_purpose, order_redacted_at
      FROM "checkout_orders" orders
     WHERE orders."id" = NEW."order_id";
    IF order_redaction_due_at IS NULL THEN
      RAISE EXCEPTION 'customer email order link is invalid';
    END IF;
    IF NEW."redaction_due_at" > order_redaction_due_at THEN
      RAISE EXCEPTION 'customer email retention exceeds order retention';
    END IF;
    IF NEW."kind" NOT IN ('shipping_policy_alert', 'contact_popup_offer')
       AND NEW."redacted_at" IS NULL
       AND (order_purpose <> 'product' OR order_redacted_at IS NOT NULL) THEN
      RAISE EXCEPTION 'active customer email requires a non-redacted product order';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "customer_email_outbox_order_retention_trigger"
BEFORE INSERT OR UPDATE OF "kind", "order_id", "submission_id", "recipient_email_normalized", "redaction_due_at", "redacted_at"
ON "customer_email_outbox"
FOR EACH ROW
EXECUTE FUNCTION "enforce_customer_email_outbox_order_retention"();--> statement-breakpoint
ALTER TABLE "customer_email_outbox" ADD CONSTRAINT "customer_email_outbox_active_customer_order_link_check" CHECK ((
        "customer_email_outbox"."kind" = 'shipping_policy_alert'
        AND "customer_email_outbox"."order_id" IS NULL
        AND "customer_email_outbox"."submission_id" IS NULL
        AND "customer_email_outbox"."recipient_email_normalized" IS NULL
      ) OR (
        "customer_email_outbox"."kind" = 'contact_popup_offer'
        AND "customer_email_outbox"."order_id" IS NULL
        AND ((
          "customer_email_outbox"."submission_id" IS NOT NULL
          AND "customer_email_outbox"."redacted_at" IS NULL
          AND "customer_email_outbox"."recipient_email_normalized" IS NOT NULL
        ) OR (
          "customer_email_outbox"."redacted_at" IS NOT NULL
          AND "customer_email_outbox"."recipient_email_normalized" IS NULL
        ))
      ) OR (
        "customer_email_outbox"."kind" NOT IN ('shipping_policy_alert', 'contact_popup_offer')
        AND "customer_email_outbox"."submission_id" IS NULL
        AND "customer_email_outbox"."recipient_email_normalized" IS NULL
        AND ("customer_email_outbox"."order_id" IS NOT NULL OR "customer_email_outbox"."redacted_at" IS NOT NULL)
      )) NOT VALID;--> statement-breakpoint
ALTER TABLE "customer_email_outbox" VALIDATE CONSTRAINT "customer_email_outbox_active_customer_order_link_check";
