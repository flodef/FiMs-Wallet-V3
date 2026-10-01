CREATE TYPE "public"."vote_kind" AS ENUM('investment', 'tontine');--> statement-breakpoint
ALTER TABLE "votes" ADD COLUMN "kind" "vote_kind" DEFAULT 'investment' NOT NULL;