CREATE TABLE "fims_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "votes" ADD COLUMN "proposer_id" integer;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_proposer_id_users_id_fk" FOREIGN KEY ("proposer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- Member-proposal eligibility threshold: share of total invested assets the
-- proposer must exceed (0.01 = strictly more than 1%).
INSERT INTO "fims_settings" ("key", "value") VALUES ('proposal_threshold', '0.01');
