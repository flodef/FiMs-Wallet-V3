-- Backfill donation_target so every donation says where the gift went:
--   'fims'    → the member's ~1% tip attached to their own operation (goes to the fund)
--   'tontine' → a real contribution to the shared tontine pot
-- Verified against the tontine wallet on-chain balances (FSOL 37.3957 /
-- FiMs 1218.722 / FLiP 1240.42 on Fe1RpesrtYMJdjwbNXtpVCDNpnFvk6jSic3sJd2aCBng).
UPDATE "transactions" SET "donation_target" = 'fims'
WHERE "id" IN (78, 122, 124, 132, 162, 182, 189, 219, 287);
--> statement-breakpoint
UPDATE "transactions" SET "donation_target" = 'tontine'
WHERE "type" = 'donation' AND "donation_target" IS NULL;
