CREATE TYPE "public"."address_book_type" AS ENUM('nexo', 'coinbase', 'binance', 'fimseur', 'other');--> statement-breakpoint
CREATE TYPE "public"."transaction_type" AS ENUM('deposit', 'withdrawal', 'donation', 'payment', 'tontine', 'conversion', 'cex_in', 'cex_out');--> statement-breakpoint
CREATE TYPE "public"."vote_status" AS ENUM('draft', 'open', 'closed');--> statement-breakpoint
CREATE TABLE "address_book" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"label" text NOT NULL,
	"address" text NOT NULL,
	"type" "address_book_type" DEFAULT 'other' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dashboard_metrics" (
	"label" text PRIMARY KEY NOT NULL,
	"value" numeric NOT NULL,
	"ratio" numeric
);
--> statement-breakpoint
CREATE TABLE "historic" (
	"date" timestamp PRIMARY KEY NOT NULL,
	"invested" numeric NOT NULL,
	"treasury" numeric
);
--> statement-breakpoint
CREATE TABLE "prices" (
	"token" text NOT NULL,
	"date" timestamp NOT NULL,
	"price" numeric NOT NULL,
	CONSTRAINT "prices_token_date_pk" PRIMARY KEY("token","date")
);
--> statement-breakpoint
CREATE TABLE "tokens" (
	"symbol" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"address" text,
	"value" numeric,
	"yearly_yield" numeric,
	"inception_ratio" numeric,
	"inception_price" numeric,
	"duration" numeric,
	"volatility" numeric,
	"description" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"date" timestamp NOT NULL,
	"type" "transaction_type",
	"address" text NOT NULL,
	"movement" numeric DEFAULT 0 NOT NULL,
	"cost" numeric DEFAULT 0 NOT NULL,
	"token" text,
	"amount" numeric,
	"signature" text,
	"donation_target" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_historic" (
	"user_id" integer NOT NULL,
	"date" timestamp NOT NULL,
	"invested" numeric NOT NULL,
	"total" numeric,
	CONSTRAINT "user_historic_user_id_date_pk" PRIMARY KEY("user_id","date")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"address" text NOT NULL,
	"is_public" boolean DEFAULT true NOT NULL,
	"is_pro" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "vote_ballots" (
	"vote_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"option_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "vote_ballots_vote_id_user_id_pk" PRIMARY KEY("vote_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "vote_options" (
	"id" serial PRIMARY KEY NOT NULL,
	"vote_id" integer NOT NULL,
	"label" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "votes" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" "vote_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"closes_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "address_book" ADD CONSTRAINT "address_book_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_historic" ADD CONSTRAINT "user_historic_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vote_ballots" ADD CONSTRAINT "vote_ballots_vote_id_votes_id_fk" FOREIGN KEY ("vote_id") REFERENCES "public"."votes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vote_ballots" ADD CONSTRAINT "vote_ballots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vote_ballots" ADD CONSTRAINT "vote_ballots_option_id_vote_options_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."vote_options"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vote_options" ADD CONSTRAINT "vote_options_vote_id_votes_id_fk" FOREIGN KEY ("vote_id") REFERENCES "public"."votes"("id") ON DELETE cascade ON UPDATE no action;