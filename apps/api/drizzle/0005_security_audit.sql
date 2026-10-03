CREATE TABLE "admin_audit_log" (
	"action" text NOT NULL,
	"admin_address" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"detail" text,
	"id" serial PRIMARY KEY NOT NULL,
	"resource_id" text
);
--> statement-breakpoint
CREATE TABLE "used_signatures" (
	"created_at" timestamp DEFAULT now() NOT NULL,
	"signature" text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "request_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_user_request_uniq" ON "transactions" USING btree ("user_id","request_id");
--> statement-breakpoint
-- The audit trail only proves anything if rows cannot be rewritten or
-- removed afterwards: the admin key is already a compromise scenario, so the
-- ledger must be append-only at the database level, not by convention.
CREATE OR REPLACE FUNCTION admin_audit_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'admin_audit_log is append-only';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER admin_audit_log_no_write BEFORE UPDATE OR DELETE ON "admin_audit_log" FOR EACH ROW EXECUTE FUNCTION admin_audit_log_append_only();
