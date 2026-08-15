CREATE TABLE "admin_step_up_proofs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nonce_hash" text NOT NULL,
	"actor_admin_user_id" uuid NOT NULL,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"authenticated_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_step_up_proofs_nonce_hash_unique" UNIQUE("nonce_hash"),
	CONSTRAINT "admin_step_up_proofs_expiry_check" CHECK ("admin_step_up_proofs"."expires_at" > "admin_step_up_proofs"."authenticated_at" AND "admin_step_up_proofs"."expires_at" <= "admin_step_up_proofs"."authenticated_at" + interval '5 minutes')
);
--> statement-breakpoint
ALTER TABLE "order_payment_obligations" ADD COLUMN "initialization_payload_hash" text;--> statement-breakpoint
ALTER TABLE "admin_step_up_proofs" ADD CONSTRAINT "admin_step_up_proofs_actor_admin_user_id_admin_users_id_fk" FOREIGN KEY ("actor_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_step_up_proofs_actor_expiry_idx" ON "admin_step_up_proofs" USING btree ("actor_admin_user_id","expires_at");