-- Semantics: donation_target = 'tontine' iff the gifted token sits in the
-- tontine wallet (Fe1Rpesr...) — the account contents must equal the sum of
-- matching transactions exactly. Everything else (EUR cash gifts, the ~1%
-- tips attached to a member's own operation, tokens never received by the
-- tontine) is a donation to an external association.
UPDATE "transactions" SET "donation_target" = 'association'
WHERE "type" = 'donation' AND (
  "donation_target" = 'fims'
  OR "token" IS NULL
  OR "token" NOT IN ('FSOL', 'FLiP', 'FiMs')
  OR "id" IN (78, 122, 124, 132, 162, 182, 189, 219, 287)
);
