CREATE TABLE "strategy_ops" (
	"collateral_amount" text NOT NULL,
	"deposit_pda" text PRIMARY KEY NOT NULL,
	"error" text,
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	"issue_signature" text,
	"member" text NOT NULL,
	"ops_signature" text,
	"status" text NOT NULL,
	"strategy_index" integer NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
