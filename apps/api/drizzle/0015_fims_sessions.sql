CREATE TABLE "fims_sessions" (
	"address" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"last_seen_at" timestamp,
	"token_hash" text PRIMARY KEY NOT NULL
);
