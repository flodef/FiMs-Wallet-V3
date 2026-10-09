CREATE TABLE "wrapped_claims" (
	"created_at" timestamp DEFAULT now() NOT NULL,
	"custodial_signature" text,
	"mint" text NOT NULL,
	"state" text NOT NULL,
	"signature" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "wrapped_claims_signature_mint_pk" PRIMARY KEY("signature","mint")
);
