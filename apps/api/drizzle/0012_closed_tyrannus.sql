CREATE TABLE "rate_limits" (
	"bucket" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"window_start" timestamp NOT NULL,
	CONSTRAINT "rate_limits_bucket_window_start_pk" PRIMARY KEY("bucket","window_start")
);
