ALTER TABLE "wrapped_claims" ADD COLUMN "product_units" numeric;--> statement-breakpoint
ALTER TABLE "wrapped_claims" ADD COLUMN "user_id" integer;--> statement-breakpoint
ALTER TABLE "wrapped_claims" ADD CONSTRAINT "wrapped_claims_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;