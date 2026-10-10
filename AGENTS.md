# Agent Guidelines for FiMs Wallet

## Deployment & Infrastructure

- **The API deploys on Vercel**, not Cloudflare: serverless function `api/[...path].ts`, routes under `/api/*` on `https://wallet-v3.fims.fi`. `apps/api/wrangler.jsonc` is legacy — never suggest `wrangler deploy` / `wrangler secret put`; use `bunx vercel env add <NAME> production` from the repo root.
- **Single Neon Postgres database** shared by all environments (`DATABASE_URL` in `apps/api/.env` IS the production DB). Apply drizzle migrations directly and verify by querying — do not ask the user to check.
- **cron-job.org**: API key in the pass store at `cron-job-org/api-key`. Keeper automation jobs: "FiMs Strategy Keeper (prod)" (`8587518`, POST `/api/fims/strategy/delegate-run` every minute — also settles queued `awaiting_liquidity` redeems and reconciles tontine donations) and "FiMs Strategy Monitor (prod)" (`8587519`, GET `/api/fims/strategy/status` every 5 min, failure alerts on).
- **Security-relevant env vars** (all parsed fail-closed — malformed values throw, they never silently disable a guard): `FIMS_WRAPPED_PRICE_BREAKER`, `FIMS_WRAPPED_MEMBER_DAILY_UNITS`, `FIMS_WRAPPED_GLOBAL_DAILY_UNITS`, `FIMS_EURO_FLOAT`/`FIMS_USD_FLOAT`, `FIMS_YIELD_EXTRA_PROGRAMS` (treat as a code change — it widens the custodial CPI allowlist), `RATE_LIMIT_IP_HEADER` (single trusted edge header for rate limiting, default `x-vercel-forwarded-for`), `FIMS_VERIFY_RPC_URL` (second independent RPC — when set, deposits must produce identical payer+deltas on both providers before the ledger credits them).

## Commands

- **Build**: `bun run build`
- **Lint**: `bun lint` / `bun lint:fix`
- **Type Check**: `bun check-types`
- **Test All**: `bun run test` / `bun run test:watch`
- **Single Test**: `bun run test <path/to/test.ts>`
- **Format**: `bun format` / `bun format:check`

## Code Style

- **TypeScript**: Strict mode, consistent type definitions/imports
- **Formatting**: Biome (single quotes, 120 width, no semicolons, trailing commas)
- **Linting**: Biome
- **Naming**: camelCase variables/functions, PascalCase types
- **Error Handling**: Use `tryCatch` from `@workspace/core`
- **Testing**: Vitest globals, jsdom env, ARRANGE/ACT/ASSERT pattern
- **Imports**: Type imports separate, alphabetical sorting

## Dependency Update Guidelines

- Do not treat currently open Dependabot PRs as a complete source of truth; always compute the full eligible set before and after the update pass.
- Group Dependabot updates by explicit vendor or ecosystem patterns, not generic buckets.
- Keep workspace manifest `catalog:` references intact. If tooling rewrites a `catalog:` entry to a pinned version, restore `catalog:` and move the version bump to root `package.json` `catalog`.
- Match local dependency update behavior to Dependabot cooldown policy. With `cooldown.default-days: 5`, use `--minimum-release-age=432000` in update and verification commands.
- Run `bun check-types` after lockfile regeneration for dependency update batches.
- Use `bun update --latest --minimum-release-age=432000 -r` for the update pass, then require zero remaining rows from `bun outdated --minimum-release-age=432000 -r --no-progress` before calling it complete.

## Testing Guidelines

### Test Structure

All tests must follow this strict structure:

```typescript
describe("function-name", () => {
  beforeEach(async () => {
    // Clear database or reset state
  });

  describe("expected behavior", () => {
    it("should do something when condition is met", async () => {
      // Test implementation
    });
  });

  describe("unexpected behavior", () => {
    beforeEach(() => {
      vi.spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("should throw an error when something fails", async () => {
      // Test implementation
    });
  });
});
```

### Test Sections

1. **Expected Behavior**: Tests for normal operation and valid inputs
2. **Unexpected Behavior**: Tests for error handling, invalid inputs, and edge cases — must mock `console.log` in `beforeEach` and restore mocks in `afterEach`

Exception: `*.integration.test.ts` files may omit the `unexpected behavior` section when the test is a focused happy-path wrapper around an external service, RPC endpoint, or runtime integration and adding synthetic failure cases would expand the intended coverage. Keep the `expected behavior` section and ARRANGE/ACT/ASSERT structure.

### Test Pattern: ARRANGE/ACT/ASSERT

Every test must follow the ARRANGE/ACT/ASSERT pattern with explicit comments:

```typescript
it("should create a network", async () => {
  // ARRANGE
  expect.assertions(2); // REQUIRED: Explicit assertion count
  const input = testNetworkInputCreate();

  // ACT
  const result = await networkCreate(db, input); // REQUIRED: Results must be called result, result1, etc...

  // ASSERT
  expect(result).toBeDefined();
  expect(result?.name).toBe(input.name);
});
```

### Combined ACT & ASSERT

For error testing, ACT & ASSERT can be combined:

```typescript
it("should throw an error with an invalid key", async () => {
  // ARRANGE
  expect.assertions(1); // REQUIRED: Explicit assertion count
  const input = testNetworkInputCreate({
    // @ts-expect-error: Testing invalid input
    type: "invalid-type",
  });

  // ACT & ASSERT
  await expect(networkCreate(db, input)).rejects.toThrow();
});
```

### Key Requirements

1. **Explicit Assertions**: Every test MUST start with `expect.assertions(N)` where N is the exact number of assertions
2. **Comments**: All ARRANGE/ACT/ASSERT sections must have explicit comments
3. **Console Mocking**: Unexpected behavior tests must mock console.log to avoid noise
4. **Type Errors**: Use `// @ts-expect-error: Testing invalid input` for intentional type violations
5. **Clear Descriptions**: Test descriptions should clearly state what is being tested and under what conditions

## Security Rules

- **Never** use `dangerouslySetInnerHTML` (or `innerHTML`, `document.write`, `eval`) with anything other than static markup bundled at build time. The only existing exception is `apps/web/src/landing/landing-page.tsx`, which injects a build-time HTML asset — any new usage needs an explicit justification comment and a biome-ignore.
- **Never** put user signing keys server-side: no private keys, seeds, mnemonics, or decrypted wallet secrets in `apps/api`, env vars, the database, or logs. Signing happens client-side only. The single documented exception is `CUSTODIAL_KEYPAIR` (apps/api custodial service) — mint authority + custody wallet for the wrapped FiMs products, a deliberate hot key that must never be extended to user funds.
- **Never** log or persist decrypted key material; clear cached CryptoKeys on lock and on failed unlock.
- When rendering external data (token metadata, memos, transaction labels, Solana Pay fields, dApp-provided strings), rely on React escaping — no manual HTML injection.
- New send/transfer recipients must stay visible by name when known (account name, bookmark label, `fims-known-recipients.ts` registry); unknown recipients must keep the `sendConfirmUnknownRecipient` warning. The same labeling applies to dApp signing prompts (`feature-request`), where `analyze-wire-inspection` must run before any transaction signature.

## Devnet Testing

- A funded throwaway devnet wallet exists for live devnet verification: `GyU9ZpTL3ce8kfS6XSpoiXaiiGb9svJfFEWer33SMmPS`.
- Its keypair lives locally at `~/.config/fims/devnet-test-wallet.json` (never committed). Top it up via the user or a faucet when drained — do not regenerate a new one.
- Jupiter APIs are mainnet-only: swaps/quotes cannot be E2E-tested on devnet, only account-level flows (mint/ATA creation, transfers).

## FiMs Ledger Conventions

- The `transactions` table is the single source of truth (spreadsheet is legacy input only).
- Every `type='donation'` row MUST carry `donation_target`: `'tontine'` means the gifted token physically sits in the tontine wallet; `'association'` (or another organism name) means an external donation.
- `donation_amount` is a gift ON TOP of `amount` on an outflow row (`amount < 0`): extra token units sent to `donation_target`, priced at the row's implied rate `|movement + cost| / |amount|` (`|movement + cost|` = gross value before fee). Lets one row carry e.g. a withdrawal + tontine share + operating fee. Pure donations keep it NULL; rejected on `donation`/`payment`/`tontine` rows.
- Reconciliation invariant: for each token, `SUM(COALESCE(donation_amount, amount)) WHERE donation_target='tontine'` must equal the on-chain balance of the tontine wallet `Fe1RpesrtYMJdjwbNXtpVCDNpnFvk6jSic3sJd2aCBng`. Verified after the 2026-10-08 reconciliation: FSOL 2.52, FiMs 84.4, FLiP 0.
- The API rejects donation creation without `donationTarget` (400), and `donationAmount` without `donationTarget` / not positive / on an inflow or `donation`/`payment`/`tontine` row (400).
- Current values (token prices, member total/gains/tontine debt) come from the Google Sheet — `tokens.value` and `user_historic` lag it by days. Read it via `sheets.googleapis.com/v4/spreadsheets/{GOOGLE_SPREADSHEET_ID}/values/{Tab}!{range}?valueRenderOption=UNFORMATTED_VALUE&key={GOOGLE_API_KEY}` (env in `apps/api/.env`, header `Referer: https://www.fims.fi`). Tabs: `Tokens` (live prices), `Portfolio` (legacy id ↔ member), numeric tabs = per-member history (newest row first, col I = Total).

## Tontine carve on member operations

- While a member's tontine debt (`computeFimsDebt` > 0) remains, `tontineRate` of every outgoing amount is carved to the pot `FIMS_TONTINE_ADDRESS`, deducted from the sent amount (never on top), capped at the remaining debt in units — and raised to the debt when the send exceeds `position − debt` (exit rule: cashing out the last euros settles the debt in full). See `computeFimsTontineCarve`.
- The operating fee is charged in kind on the sent mint (`computeFimsSendSplit`) — a second carved recipient to `FIMS_TREASURY_ADDRESS`. No SOL is required from the sender.
- Plain sends carry carve+fee as extra recipients in the same tx (`getSendExtraRecipients` in `fims-modals.tsx`); swaps append the pot transfer to Jupiter's instructions (`useFimsSwap`, `useFimsStrategySwap`, `useFimsSwapTo` — all on `/swap/v2/build` since Metis `/swap/v1` is deprecated) — swaps are conversions in place, so the exit rule does not apply to them. Swaps build at the highest version the signer advertises (`getAccountTransactionVersion`): v1 for local keypairs and v1-capable wallets, v0 as fallback; v1 drops ALTs and carries CU/loaded-accounts limits in the message config (estimated by `estimateAndSetResourceLimitsFactory`).
- Sends to the treasury or the pot are exempt (debt settlement / donation), as are Solana Pay requests and trigger/limit orders (exact-amount or keeper-settled — the carve cannot ride along).

## On-chain strategy program (`solana-programs`)

- The vault is delegate-driven but post-conditioned: every whitelisted CPI is verified AFTER the call (position accounting, vault-ATA deltas, ATA health, undeclared-account integrity). Keep those checks — never weaken them.
- SPL Token **and** Token-2022 are supported (FLiP is T22). ATA derivations take the mint's actual token program — `require_ata_owned` resolves it from the account's own `owner` field; mint-side (`share_mint.owner`) when the ATA doesn't exist yet. Client builders resolve the program via `mintTokenProgram` — never hardcode the legacy program for FLiP paths.
- Rolling 24h windows use hourly buckets keyed `hour % 24`; `window_start_hour` is the oldest still-counted hour. Clearing expires only hours `[ws, now-24]` — clearing more degrades the cap to per-hour. (`elapsed < 24` must yield `stale = 0` — a negative `i64` cast to `usize` wraps and hangs the program on-CU.)
- Each `MintPair` carries `daily_cap` (input units / 24h) bounding delegate swap volume — the bounded-loss defense for unbounded pairs; `max_deviation_bps` stays for near-equivalents.
- `MAX_MINT_PAIRS = 8` — larger pushes `StrategyState::SPACE` past the 10,240-byte CPI-init limit and `initialize` can never create the account.
- Every dangerous change is timelocked 48h via `schedule_config`/`apply_config`: whitelists, strategies, caps, mint pairs, **treasury, delegate and admin** (no instant `set_delegate`/`propose_admin` — a compromised delegate/admin is handled by `guardian_pause` first, then the scheduled rotation applies while frozen; admin handover additionally needs the new admin's `accept_admin` signature). Only one pending change at a time (`pending.is_none()`) — admin retracts via `admin_cancel_pending`, guardian vetoes via `guardian_cancel_pending`. Treasury/delegate/admin must not be `Pubkey::default()`.
- Build for mainnet/localnet with `cargo-build-sbf --arch v3` — the default v0 ELF is rejected by the Agave 4.1 runtime.
- `initialize` is upgrade-authority-gated: deploy upgradeable, initialize BEFORE transferring the upgrade authority (target: the Squads multisig).
- The delegate tip is mandatory on `deposit`: `MIN_TIP = 0.0005 SOL` (funds ~100 keeper tx, self-financing), `MAX_TIP = 0.01 SOL` (fat-finger bound). No priority fees — the cron retries dropped transactions.
- `/fims/strategy/status` also watches position-account health (owner, size, embedded NFT mint) — an upstream Fluid upgrade that drifts the layout shows up as unhealthy there.

