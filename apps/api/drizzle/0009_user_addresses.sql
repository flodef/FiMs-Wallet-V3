-- Multi-wallet members: extra addresses linked to a user. The canonical
-- address stays in users.address; aliases live here. An address can only
-- be linked once, so member resolution by address stays unambiguous.
CREATE TABLE "user_addresses" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"address" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_addresses_address_unique" UNIQUE("address")
);
--> statement-breakpoint
ALTER TABLE "user_addresses" ADD CONSTRAINT "user_addresses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
