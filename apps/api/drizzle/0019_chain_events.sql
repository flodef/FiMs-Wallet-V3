CREATE TABLE "chain_events" (
	"address" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"id" serial PRIMARY KEY NOT NULL,
	"signature" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "chain_events_address_idx" ON "chain_events" USING btree ("address");