ALTER TABLE "product_order_customer_decisions" ADD COLUMN "legal_follow_up_evidence_reference" text;--> statement-breakpoint
ALTER TABLE "product_order_customer_decisions" ADD COLUMN "legal_follow_up_rationale" text;--> statement-breakpoint
ALTER TABLE "product_order_customer_decisions" ADD COLUMN "legal_follow_up_by_admin_user_id" uuid;--> statement-breakpoint
ALTER TABLE "product_order_customer_decisions" ADD COLUMN "legal_follow_up_step_up_authenticated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_order_customer_decisions" ADD COLUMN "legal_follow_up_recorded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_order_refunds" ADD COLUMN "manual_review_evidence_reference" text;--> statement-breakpoint
ALTER TABLE "product_order_refunds" ADD COLUMN "manual_review_rationale" text;--> statement-breakpoint
ALTER TABLE "product_order_refunds" ADD COLUMN "manual_review_by_admin_user_id" uuid;--> statement-breakpoint
ALTER TABLE "product_order_refunds" ADD COLUMN "manual_review_step_up_authenticated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_order_refunds" ADD COLUMN "manual_review_recorded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_shipment_jobs" ADD COLUMN "reconciliation_evidence_reference" text;--> statement-breakpoint
ALTER TABLE "product_shipment_jobs" ADD COLUMN "reconciliation_rationale" text;--> statement-breakpoint
ALTER TABLE "product_shipment_jobs" ADD COLUMN "reconciliation_requested_by_admin_user_id" uuid;--> statement-breakpoint
ALTER TABLE "product_shipment_jobs" ADD COLUMN "reconciliation_step_up_authenticated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_shipment_jobs" ADD COLUMN "reconciliation_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_shipment_return_observations" ADD COLUMN "admin_resolution_action" text;--> statement-breakpoint
ALTER TABLE "product_shipment_return_observations" ADD COLUMN "admin_resolution_evidence_reference" text;--> statement-breakpoint
ALTER TABLE "product_shipment_return_observations" ADD COLUMN "admin_resolution_rationale" text;--> statement-breakpoint
ALTER TABLE "product_shipment_return_observations" ADD COLUMN "resolved_by_admin_user_id" uuid;--> statement-breakpoint
ALTER TABLE "product_shipment_return_observations" ADD COLUMN "resolution_step_up_authenticated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_shipment_return_observations" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_shipment_return_observations" ADD COLUMN "resolved_state_version" integer;--> statement-breakpoint
ALTER TABLE "product_shipment_return_observations" ADD COLUMN "state_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "product_shipments" ADD COLUMN "manual_review_evidence_reference" text;--> statement-breakpoint
ALTER TABLE "product_shipments" ADD COLUMN "manual_review_rationale" text;--> statement-breakpoint
ALTER TABLE "product_shipments" ADD COLUMN "manual_review_by_admin_user_id" uuid;--> statement-breakpoint
ALTER TABLE "product_shipments" ADD COLUMN "manual_review_step_up_authenticated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_order_customer_decisions" ADD CONSTRAINT "product_order_customer_decisions_legal_follow_up_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("legal_follow_up_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_order_refunds" ADD CONSTRAINT "product_order_refunds_manual_review_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("manual_review_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_shipment_jobs" ADD CONSTRAINT "product_shipment_jobs_reconciliation_requested_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("reconciliation_requested_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_shipment_return_observations" ADD CONSTRAINT "product_shipment_return_observations_resolved_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("resolved_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_shipments" ADD CONSTRAINT "product_shipments_manual_review_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("manual_review_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_order_customer_decisions" ADD CONSTRAINT "product_order_customer_decisions_legal_follow_up_evidence_check" CHECK ((
        "product_order_customer_decisions"."legal_follow_up_evidence_reference" IS NULL
        AND "product_order_customer_decisions"."legal_follow_up_rationale" IS NULL
        AND "product_order_customer_decisions"."legal_follow_up_by_admin_user_id" IS NULL
        AND "product_order_customer_decisions"."legal_follow_up_step_up_authenticated_at" IS NULL
        AND "product_order_customer_decisions"."legal_follow_up_recorded_at" IS NULL
      ) OR (
        length(trim("product_order_customer_decisions"."legal_follow_up_evidence_reference")) >= 6
        AND length(trim("product_order_customer_decisions"."legal_follow_up_rationale")) >= 10
        AND "product_order_customer_decisions"."legal_follow_up_by_admin_user_id" IS NOT NULL
        AND "product_order_customer_decisions"."legal_follow_up_step_up_authenticated_at" <= "product_order_customer_decisions"."legal_follow_up_recorded_at"
        AND "product_order_customer_decisions"."legal_follow_up_step_up_authenticated_at" >= "product_order_customer_decisions"."legal_follow_up_recorded_at" - interval '5 minutes'
      ));--> statement-breakpoint
ALTER TABLE "product_order_refunds" ADD CONSTRAINT "product_order_refunds_manual_review_evidence_check" CHECK ((
        "product_order_refunds"."manual_review_evidence_reference" IS NULL
        AND "product_order_refunds"."manual_review_rationale" IS NULL
        AND "product_order_refunds"."manual_review_by_admin_user_id" IS NULL
        AND "product_order_refunds"."manual_review_step_up_authenticated_at" IS NULL
        AND "product_order_refunds"."manual_review_recorded_at" IS NULL
      ) OR (
        length(trim("product_order_refunds"."manual_review_evidence_reference")) >= 6
        AND length(trim("product_order_refunds"."manual_review_rationale")) >= 10
        AND "product_order_refunds"."manual_review_by_admin_user_id" IS NOT NULL
        AND "product_order_refunds"."manual_review_step_up_authenticated_at" <= "product_order_refunds"."manual_review_recorded_at"
        AND "product_order_refunds"."manual_review_step_up_authenticated_at" >= "product_order_refunds"."manual_review_recorded_at" - interval '5 minutes'
      ));--> statement-breakpoint
ALTER TABLE "product_shipment_jobs" ADD CONSTRAINT "product_shipment_jobs_reconciliation_evidence_check" CHECK ((
        "product_shipment_jobs"."reconciliation_evidence_reference" IS NULL
        AND "product_shipment_jobs"."reconciliation_rationale" IS NULL
        AND "product_shipment_jobs"."reconciliation_requested_by_admin_user_id" IS NULL
        AND "product_shipment_jobs"."reconciliation_step_up_authenticated_at" IS NULL
        AND "product_shipment_jobs"."reconciliation_requested_at" IS NULL
      ) OR (
        length(trim("product_shipment_jobs"."reconciliation_evidence_reference")) >= 6
        AND length(trim("product_shipment_jobs"."reconciliation_rationale")) >= 10
        AND "product_shipment_jobs"."reconciliation_requested_by_admin_user_id" IS NOT NULL
        AND "product_shipment_jobs"."reconciliation_step_up_authenticated_at" <= "product_shipment_jobs"."reconciliation_requested_at"
        AND "product_shipment_jobs"."reconciliation_step_up_authenticated_at" >= "product_shipment_jobs"."reconciliation_requested_at" - interval '5 minutes'
      ));--> statement-breakpoint
ALTER TABLE "product_shipment_return_observations" ADD CONSTRAINT "product_shipment_returns_state_version_check" CHECK ("product_shipment_return_observations"."state_version" >= 1);--> statement-breakpoint
ALTER TABLE "product_shipment_return_observations" ADD CONSTRAINT "product_shipment_returns_admin_resolution_check" CHECK ((
        "product_shipment_return_observations"."admin_resolution_action" IS NULL
        AND "product_shipment_return_observations"."admin_resolution_evidence_reference" IS NULL
        AND "product_shipment_return_observations"."admin_resolution_rationale" IS NULL
        AND "product_shipment_return_observations"."resolved_by_admin_user_id" IS NULL
        AND "product_shipment_return_observations"."resolution_step_up_authenticated_at" IS NULL
        AND "product_shipment_return_observations"."resolved_at" IS NULL
        AND "product_shipment_return_observations"."resolved_state_version" IS NULL
      ) OR (
        "product_shipment_return_observations"."admin_resolution_action" IN ('record_inspection', 'escalate_unmatched_return', 'confirm_linked_case')
        AND length(trim("product_shipment_return_observations"."admin_resolution_evidence_reference")) >= 6
        AND length(trim("product_shipment_return_observations"."admin_resolution_rationale")) >= 10
        AND "product_shipment_return_observations"."resolved_by_admin_user_id" IS NOT NULL
        AND "product_shipment_return_observations"."resolution_step_up_authenticated_at" <= "product_shipment_return_observations"."resolved_at"
        AND "product_shipment_return_observations"."resolution_step_up_authenticated_at" >= "product_shipment_return_observations"."resolved_at" - interval '5 minutes'
        AND "product_shipment_return_observations"."resolved_state_version" >= 2
        AND "product_shipment_return_observations"."resolved_state_version" <= "product_shipment_return_observations"."state_version"
      ));--> statement-breakpoint
ALTER TABLE "product_shipments" ADD CONSTRAINT "product_shipments_manual_review_evidence_check" CHECK ((
        "product_shipments"."manual_review_evidence_reference" IS NULL
        AND "product_shipments"."manual_review_rationale" IS NULL
        AND "product_shipments"."manual_review_by_admin_user_id" IS NULL
        AND "product_shipments"."manual_review_step_up_authenticated_at" IS NULL
      ) OR (
        "product_shipments"."manual_review_acknowledged_at" IS NOT NULL
        AND length(trim("product_shipments"."manual_review_evidence_reference")) >= 6
        AND length(trim("product_shipments"."manual_review_rationale")) >= 10
        AND "product_shipments"."manual_review_by_admin_user_id" IS NOT NULL
        AND "product_shipments"."manual_review_step_up_authenticated_at" <= "product_shipments"."manual_review_acknowledged_at"
        AND "product_shipments"."manual_review_step_up_authenticated_at" >= "product_shipments"."manual_review_acknowledged_at" - interval '5 minutes'
      ));