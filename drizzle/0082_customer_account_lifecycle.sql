CREATE TABLE "customer_account_commands" (
	"command_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"account_version" bigint NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"action" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"command" jsonb NOT NULL,
	"requested_by_admin_id" uuid,
	CONSTRAINT "customer_account_commands_action" CHECK ("customer_account_commands"."action" IN ('suspend', 'restore', 'export', 'delete')),
	CONSTRAINT "customer_account_commands_version" CHECK ("customer_account_commands"."account_version" BETWEEN 1 AND 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "customer_account_deliveries" (
	"command_id" uuid NOT NULL,
	"receiver" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"lease_id" uuid,
	"acknowledged_at" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "customer_account_deliveries_receiver" CHECK ("customer_account_deliveries"."receiver" IN ('course', 'community')),
	CONSTRAINT "customer_account_deliveries_status" CHECK ("customer_account_deliveries"."status" IN ('pending', 'delivering', 'acknowledged', 'blocked'))
);
--> statement-breakpoint
CREATE TABLE "customer_account_exports" (
	"command_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"frontend_data" jsonb,
	"data" jsonb,
	"ready_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	CONSTRAINT "customer_account_exports_status" CHECK ("customer_account_exports"."status" IN ('pending', 'ready', 'expired', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "customer_account_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"learning_updates" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customer_users" ADD COLUMN "account_version" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_account_commands" ADD CONSTRAINT "customer_account_commands_user_id_customer_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."customer_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_account_deliveries" ADD CONSTRAINT "customer_account_deliveries_command_id_customer_account_commands_command_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."customer_account_commands"("command_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_account_exports" ADD CONSTRAINT "customer_account_exports_command_id_customer_account_commands_command_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."customer_account_commands"("command_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_account_exports" ADD CONSTRAINT "customer_account_exports_user_id_customer_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."customer_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_account_preferences" ADD CONSTRAINT "customer_account_preferences_user_id_customer_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."customer_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_account_commands_version_idx" ON "customer_account_commands" USING btree ("user_id","account_version");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_account_commands_idempotency_idx" ON "customer_account_commands" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_account_deliveries_identity_idx" ON "customer_account_deliveries" USING btree ("command_id","receiver");--> statement-breakpoint
CREATE INDEX "customer_account_deliveries_due_idx" ON "customer_account_deliveries" USING btree ("status","next_run_at");--> statement-breakpoint
CREATE INDEX "customer_account_exports_expiry_idx" ON "customer_account_exports" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "customer_users" ADD CONSTRAINT "customer_users_account_version" CHECK ("customer_users"."account_version" BETWEEN 0 AND 9007199254740991);
--> statement-breakpoint
CREATE FUNCTION customer_account_command_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'customer account commands are immutable' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER customer_account_command_immutable BEFORE UPDATE OR DELETE ON customer_account_commands
FOR EACH ROW EXECUTE FUNCTION customer_account_command_immutable();
--> statement-breakpoint
CREATE FUNCTION customer_account_terminal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'deleted' THEN RAISE EXCEPTION 'customer deletion tombstone is terminal' USING ERRCODE = '23514'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'deleted' AND NEW.status <> 'deleted' THEN
    RAISE EXCEPTION 'customer deletion tombstone is terminal' USING ERRCODE = '23514';
  END IF;
  IF NEW.account_version < OLD.account_version OR
     (NEW.status = 'deleted' AND (NEW.email <> 'deleted+' || NEW.id::text || '@account.invalid' OR NEW.name IS NOT NULL OR NEW.email_verified IS NOT NULL)) THEN
    RAISE EXCEPTION 'invalid customer lifecycle state' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER customer_account_terminal_guard BEFORE UPDATE OR DELETE ON customer_users
FOR EACH ROW EXECUTE FUNCTION customer_account_terminal_guard();
