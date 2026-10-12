# Deploying `fims-strategy`

Program id: `AtmC4gPAEZ1r4fD698mDaCpGEC5WZN5f4z55zscsdVmS`
IDL: `target/idl/fims_strategy.json` (regenerated on build)

## 0. Prerequisites

- rustup — `rust-toolchain.toml` pins `1.98.1` + `clippy`/`rustfmt`
- Solana platform tools (provides `cargo-build-sbf`):
  `sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"`
- `solana` CLI on the same PATH, a funded deployer keypair
  (`--url` picks the cluster; ~2–3 SOL for mainnet program+buffer rent)
- **Program keypair** `target/deploy/fims_strategy-keypair.json` — it IS the
  program id. Do not lose it, never commit it.
- No `anchor` CLI needed: everything below is `solana` + `cargo` + `bun`.

## 1. Build

```bash
cd solana-programs
cargo-build-sbf --arch v3    # target/deploy/fims_strategy.so
```

`--arch v3` is mandatory — the default v0 ELF is rejected by Agave 4.x
runtimes. Verify: `file target/deploy/fims_strategy.so` → ELF 64-bit.

## 2. Localnet verify

```bash
solana-test-validator --reset --ledger test-ledger &
bun run test                 # tests/poc-local.ts (initialize + PoC flows)
```

## 3. Deploy

```bash
solana program deploy target/deploy/fims_strategy.so \
  --program-id target/deploy/fims_strategy-keypair.json \
  --url <cluster-rpc-url> \
  --with-compute-unit-price 5000
```

First deploy and upgrades are the same command — the keypair decides.
`declare_id!` in `lib.rs` must keep matching the keypair's pubkey.

## 4. Initialize (once, before authority transfer)

`initialize` is upgrade-authority-gated — call it with the deployer key right
after the deploy, from a bun script modelled on `tests/poc-local.ts` (init
block, lines ~125-185): discriminator `disc('initialize')`, accounts payer +
`state` PDA (`seeds = ["state"]`), `InitializeArgs` = admin, delegate,
guardian, treasury, allowed_programs, mint_pairs (caps), risk_target.

Until `initialize` runs, the program has no `state` account — `/fims/strategy/*`
routes return "not initialized".

## 5. Transfer the upgrade authority → Squads multisig (post-verify)

```bash
solana program set-upgrade-authority AtmC4gPAEZ1r4fD698mDaCpGEC5WZN5f4z55zscsdVmS \
  --new-upgrade-authority <squads-multisig-vault> \
  --url <cluster-rpc-url>
```

Only after this is `initialize` unreachable — order matters (docs
`security-remediation.md`: the transfer is the last manual step).

## Ops notes

- The cron keeper (`/api/fims/strategy/delegate-run`, every minute) tolerates a
  brief deploy window — retries handle dropped txs.
- `cargo update -p anchor-lang` for SDK bumps; redeploy = same build+deploy.
- Keep the deployed bytecode reproducible: always deploy from a clean tree.

## Deployed instances

### devnet (smoke test, anchor-lang 1.2.1 — 2026-10-12)

- Program: `AtmC4gPAEZ1r4fD698mDaCpGEC5WZN5f4z55zscsdVmS` ✅ executable
- ProgramData: `7pbBfodizcoRTUUTzjMzWeJTPBYdzitufVEMe2qRyS43`
- Upgrade authority: `GyU9ZpTL3ce8kfS6XSpoiXaiiGb9svJfFEWer33SMmPS`
  (throwaway test wallet — `~/.config/fims/devnet-test-wallet*.json`)
- `initialize` ✅ (sig `2sWopNGAqJHM…`): admin+guardian = test wallet,
  delegate = `EgLm7eFGry44VQTsxbHRcb5QK4NW9BRSSt7xn1dLUz2r` (API keeper hot
  key — derived from `STRATEGY_DELEGATE_KEYPAIR`), treasury = FiMs treasury,
  `state` PDA `2uvpWqWtMtj9ccRLv7TdheLA9eT3xfWvG6PnZEyEjz6X`
- Whitelists empty on purpose: no Fluid positions exist on devnet — this
  instance is a deploy/initialize rehearsal, not a working strategy.

### mainnet — not deployed yet

Deploy once the strategy feature is finalized (one paid deploy ~3–5 SOL,
then the Squads authority transfer).
