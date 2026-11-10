CREATE TABLE "customer_auth_throttle" (
	"key" text PRIMARY KEY NOT NULL,
	"attempts" integer NOT NULL,
	"resets_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_provider_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_provider_links_provider" CHECK ("customer_provider_links"."provider" = 'google' AND "customer_provider_links"."type" = 'oidc')
);
--> statement-breakpoint
CREATE TABLE "customer_sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"email_verified" timestamp with time zone,
	"name" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_users_email_normalized" CHECK ("customer_users"."email" = lower(trim("customer_users"."email"))),
	CONSTRAINT "customer_users_status" CHECK ("customer_users"."status" IN ('active', 'suspended', 'deleted'))
);
--> statement-breakpoint
CREATE TABLE "customer_verification_tokens" (
	"token" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"expires" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customer_provider_links" ADD CONSTRAINT "customer_provider_links_user_id_customer_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."customer_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_sessions" ADD CONSTRAINT "customer_sessions_user_id_customer_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."customer_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_provider_links_identity_idx" ON "customer_provider_links" USING btree ("provider","provider_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_provider_links_user_provider_idx" ON "customer_provider_links" USING btree ("user_id","provider");--> statement-breakpoint
CREATE INDEX "customer_sessions_user_idx" ON "customer_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "customer_sessions_expiry_idx" ON "customer_sessions" USING btree ("expires");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_users_email_idx" ON "customer_users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "customer_verification_tokens_expiry_idx" ON "customer_verification_tokens" USING btree ("expires");