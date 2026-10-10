use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::{invoke, invoke_signed};
use anchor_lang::solana_program::pubkey::Pubkey;
use anchor_lang::solana_program::system_instruction;

declare_id!("AtmC4gPAEZ1r4fD698mDaCpGEC5WZN5f4z55zscsdVmS");

// ---------------------------------------------------------------------------
// FiMs strategy vault
//
// A program-owned vault (PDA) that holds the leveraged positions backing FSOL
// and FLIP: Jupiter Lend borrow positions (vault 52 JUPSOL/USDT, vault 50
// JLP/USDT) and Kamino OnRe USDG supply. A delegate key — an automated
// operator — drives every operation, but value can only loop
// `vault ATA -> whitelisted protocol -> vault ATA`.
//
// Security model — post-conditions, not trust:
//   * every protocol instruction is checked AFTER the CPI: token balances
//     must have moved in the declared direction and amount, position NFTs
//     must still be vault-owned, vault ATAs must stay healthy (owner = vault,
//     no delegate, no close authority)
//   * the only exits to arbitrary destinations are `payout`/`payout_token`,
//     capped per-tx and over a rolling 24h window, destination allowlisted
//   * `sweep` can only pay the hardcoded treasury
//   * a compromised delegate key can therefore not route funds to itself:
//     every direction of flow is asserted, not assumed
//   * governance: every dangerous change — including admin rotation — goes
//     through the 48h timelock; a guardian role can pause (but not unpause)
//     and veto a pending change for fast incident response
// ---------------------------------------------------------------------------

// SPL Token program and Associated Token Account program — hardcoded so the
// delegate can never point derivations at a look-alike.
pub const TOKEN_PROGRAM_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
// Token-2022 mints (e.g. FLiP) derive their ATAs under this program — the
// vault supports both, resolved per account via its program owner.
pub const TOKEN_2022_PROGRAM_ID: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const ATA_PROGRAM_ID: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const SYSTEM_PROGRAM_ID: Pubkey = pubkey!("11111111111111111111111111111111");

const ADMIN_TIMELOCK_SECS: i64 = 48 * 3600;
const HOUR_SECS: i64 = 3_600;
const MAX_ALLOWED_PROGRAMS: usize = 16;
const MAX_MEMBERS: usize = 64;
const MAX_STRATEGIES: usize = 4;
// 8 pairs keeps StrategyState::SPACE under the 10,240-byte CPI-init limit —
// account creation via inner instruction cannot realloc more than that.
const MAX_MINT_PAIRS: usize = 8;
// The delegate tip is the keeper's only revenue: the minimum makes it
// mandatory (no free-riding a placement pass), the maximum bounds a
// fat-fingered client at ~€2 so a deposit can never silently drain more.
const MIN_TIP_LAMPORTS: u64 = 500_000; // 0.0005 SOL — expected tip
const MAX_TIP_LAMPORTS: u64 = 10_000_000; // 0.01 SOL — fat-finger bound

// SPL Token account layout offsets (165 bytes).
const TA_OWNER: usize = 32;
const TA_AMOUNT: usize = 64;
const TA_DELEGATE_TAG: usize = 72;
const TA_STATE: usize = 108;
const TA_CLOSE_AUTH_TAG: usize = 129;
const TA_INITIALIZED: u8 = 1;

// Fluid vaults Position account (bytemuck packed, 71 bytes total):
//   disc(8) vaultId u16@8 | nftId u32@10 | positionMint pubkey@14
//   isSupplyOnly u8@46 | tick i32@47 | tickId u32@51
//   supplyAmount u64@55 | dustDebtAmount u64@63
const POSITION_LEN: usize = 71;
const POSITION_MINT_OFF: usize = 14;
const POSITION_SUPPLY_OFF: usize = 55;
const POSITION_DEBT_OFF: usize = 63;
/// Tolerance between declared and on-chain deltas (interest accrual, fees).
const DELTA_TOLERANCE_NUM: u64 = 1;
const DELTA_TOLERANCE_DEN: u64 = 100;

#[program]
pub mod fims_strategy {
    use super::*;

    /// One-time setup, restricted to the program's upgrade authority: nobody
    /// can front-run the deployment and take admin of the vault.
    pub fn initialize(ctx: Context<Initialize>, args: InitializeArgs) -> Result<()> {
        // The ProgramData account is the PDA of the upgradeable loader for
        // this program — proves it describes THIS program.
        let (expected_pd, _) = Pubkey::find_program_address(
            &[crate::ID.as_ref()],
            &anchor_lang::solana_program::bpf_loader_upgradeable::ID,
        );
        require!(
            ctx.accounts.program_data.key() == expected_pd,
            StrategyError::BadProgramData
        );

        let data = ctx.accounts.program_data.try_borrow_data()?;
        // UpgradeableLoaderState::ProgramData = variant u32 3, slot u64,
        // then Option<Pubkey> upgrade authority (u8 tag + 32 bytes).
        require!(data.len() >= 45, StrategyError::BadProgramData);
        require!(
            u32::from_le_bytes(data[0..4].try_into().unwrap()) == 3,
            StrategyError::BadProgramData
        );
        require!(data[12] == 1, StrategyError::BadProgramData);
        let authority =
            Pubkey::try_from(&data[13..45]).map_err(|_| StrategyError::BadProgramData)?;
        require!(
            authority == ctx.accounts.payer.key(),
            StrategyError::NotUpgradeAuthority
        );
        drop(data);

        validate_whitelists(&args.allowed_programs, &args.member_whitelist)?;
        validate_strategies(&args.strategies)?;
        validate_mint_pairs(&args.allowed_mint_pairs)?;

        let state = &mut ctx.accounts.state;
        state.admin = args.admin;
        state.delegate = args.delegate;
        state.guardian = args.guardian;
        state.treasury = args.treasury;
        state.paused = false;
        state.allowed_programs = args.allowed_programs;
        state.member_whitelist = args.member_whitelist;
        state.strategies = args.strategies;
        state.allowed_mint_pairs = args.allowed_mint_pairs;
        state.daily_cap_lamports = args.daily_cap_lamports;
        state.tx_cap_lamports = args.tx_cap_lamports;
        state.daily_token_cap = args.daily_token_cap;
        state.spent_sol_hourly = [0; 24];
        state.spent_token_hourly = [0; 24];
        state.spent_swap_hourly = vec![0; 24 * MAX_MINT_PAIRS];
        state.window_start_hour = 0;
        state.pending = None;
        state.proposed_admin = None;
        state.vault_bump = ctx.bumps.vault;
        state.bump = ctx.bumps.state;
        emit!(Initialized {
            admin: args.admin,
            delegate: args.delegate
        });
        Ok(())
    }

    // -- member entry ----------------------------------------------------------

    /// Member deposit: moves `amount` of the strategy's collateral mint
    /// (JUPSOL…) from the member ATA to the vault ATA and records it in the
    /// member's `member_deposit` PDA. `tip_lamports` pays the delegate for
    /// the upcoming strategy transactions in the same atomic transaction —
    /// mandatory (MIN_TIP, no free-riding the keeper) and capped at
    /// MAX_TIP_LAMPORTS so a bad client cannot silently drain the member. Deposit itself is permissionless: the
    /// member only sends funds, there is nothing to steal.
    pub fn deposit(
        ctx: Context<Deposit>,
        strategy_index: u8,
        amount: u64,
        tip_lamports: u64,
    ) -> Result<()> {
        let state = &ctx.accounts.state;
        require!(!state.paused, StrategyError::Paused);
        let strategy = state
            .strategies
            .get(strategy_index as usize)
            .ok_or(StrategyError::UnknownStrategy)?;
        // Clamp to the member ATA balance: the swap+deposit flow deposits the
        // quote's expected out amount, so a small slippage shortfall must not
        // revert the whole transaction — pending records what actually moved.
        let amount = amount.min(token_amount(&ctx.accounts.member_ata.to_account_info())?);
        require!(amount > 0, StrategyError::BadConfig);
        require!(tip_lamports >= MIN_TIP_LAMPORTS, StrategyError::TipTooSmall);
        require!(tip_lamports <= MAX_TIP_LAMPORTS, StrategyError::TipTooLarge);
        // The collateral ATA may live under SPL Token or Token-2022 — the
        // account's own program owner selects the derivation.
        let member_ata_program = require_ata_owned(
            &ctx.accounts.member_ata.to_account_info(),
            ctx.accounts.member.key(),
            strategy.collateral_mint,
        )?;
        let vault_ata_program = require_ata_owned(
            &ctx.accounts.vault_ata.to_account_info(),
            ctx.accounts.vault.key(),
            strategy.collateral_mint,
        )?;
        // Same mint => same program: a legacy member ATA and a T22 vault ATA
        // for the same mint would live at different derivations and the
        // transfer could never be reconciled.
        require!(
            vault_ata_program == member_ata_program,
            StrategyError::WrongAccount
        );
        require!(
            ctx.accounts.token_program.key() == member_ata_program,
            StrategyError::WrongAccount
        );
        require!(
            ctx.accounts.delegate.key() == state.delegate,
            StrategyError::WrongAccount
        );
        require!(
            ctx.accounts.share_mint.key() == strategy.share_mint,
            StrategyError::WrongAccount
        );
        // The share mint's program owner IS its token program — covers T22
        // share tokens (FLiP) without any config field.
        let share_token_program = *ctx.accounts.share_mint.owner;
        require!(
            share_token_program == TOKEN_PROGRAM_ID || share_token_program == TOKEN_2022_PROGRAM_ID,
            StrategyError::WrongAccount
        );
        require!(
            ctx.accounts.share_token_program.key() == share_token_program,
            StrategyError::WrongAccount
        );
        require!(
            ctx.accounts.member_share_ata.key()
                == ata_address(
                    ctx.accounts.member.key(),
                    strategy.share_mint,
                    &share_token_program
                ),
            StrategyError::WrongAccount
        );
        // The 1:1 share issuance only makes sense when collateral and share
        // tokens count in the same base units — checked against the mints
        // themselves, not a config promise.
        require!(
            ctx.accounts.collateral_mint.key() == strategy.collateral_mint,
            StrategyError::WrongAccount
        );
        let collateral_decimals = mint_decimals(&ctx.accounts.collateral_mint.to_account_info())?;
        require!(
            mint_decimals(&ctx.accounts.share_mint.to_account_info())? == collateral_decimals,
            StrategyError::BadConfig
        );

        // The member's share ATA must exist by the time the delegate issues
        // shares — create it idempotently here so the member (not the
        // delegate's tip float) pays the rent.
        invoke(
            &create_ata_ix(
                ctx.accounts.member.key(),
                ctx.accounts.member_share_ata.key(),
                ctx.accounts.member.key(),
                strategy.share_mint,
                &share_token_program,
            ),
            &[
                ctx.accounts.member.to_account_info(),
                ctx.accounts.member_share_ata.to_account_info(),
                ctx.accounts.member.to_account_info(),
                ctx.accounts.share_mint.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.share_token_program.to_account_info(),
            ],
        )?;

        // Member is a real signer — a plain invoke (no PDA seeds) moves the
        // collateral into the vault. TransferChecked: Token-2022 mints with
        // a transfer-fee extension reject plain Transfer, and `pending` must
        // record what ACTUALLY arrived — not what was sent — or shares would
        // be issued for value the vault never received.
        let received_before = token_amount(&ctx.accounts.vault_ata.to_account_info())?;
        invoke(
            &spl_transfer_checked_ix(
                &member_ata_program,
                ctx.accounts.member_ata.key(),
                strategy.collateral_mint,
                ctx.accounts.vault_ata.key(),
                ctx.accounts.member.key(),
                amount,
                collateral_decimals,
            ),
            &[
                ctx.accounts.member_ata.to_account_info(),
                ctx.accounts.collateral_mint.to_account_info(),
                ctx.accounts.vault_ata.to_account_info(),
                ctx.accounts.member.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
            ],
        )?;
        let received = token_amount(&ctx.accounts.vault_ata.to_account_info())?
            .saturating_sub(received_before);
        require!(received > 0, StrategyError::BadConfig);
        invoke(
            &system_instruction::transfer(
                &ctx.accounts.member.key(),
                &ctx.accounts.delegate.key(),
                tip_lamports,
            ),
            &[
                ctx.accounts.member.to_account_info(),
                ctx.accounts.delegate.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        let deposit = &mut ctx.accounts.member_deposit;
        deposit.member = ctx.accounts.member.key();
        deposit.strategy = strategy_index;
        deposit.bump = ctx.bumps.member_deposit;
        deposit.pending = deposit.pending.saturating_add(received);
        emit!(Deposited {
            member: deposit.member,
            strategy: strategy_index,
            amount: received,
            pending: deposit.pending
        });
        Ok(())
    }

    // -- delegate-driven protocol ops (post-conditioned) ---------------------

    /// Jupiter Lend `operate` on a configured strategy. The delegate supplies
    /// the instruction data (built off-chain by the SDK/API) and declares the
    /// intended deltas; the program replays the CPI with the vault signing,
    /// then proves the declared operation against two independent sources:
    ///   1. the position account's own supply/debt accounting — what the
    ///      position actually gained/lost, impossible to fake from outside
    ///   2. the vault's token account deltas — where the tokens went
    /// A withdrawal whose collateral lands anywhere but the vault ATA fails.
    /// A delegate that declares zero but moves funds fails. Total debt can
    /// never exceed the configured ceiling, whatever the delegate does.
    pub fn jl_operate(
        ctx: Context<ProtocolOp>,
        strategy_index: u8,
        col_delta: i64,
        debt_delta: i64,
        data: Vec<u8>,
    ) -> Result<()> {
        let state = &ctx.accounts.state;
        require!(!state.paused, StrategyError::Paused);
        let strategy = state
            .strategies
            .get(strategy_index as usize)
            .ok_or(StrategyError::UnknownStrategy)?;
        require!(
            col_delta != i64::MIN && debt_delta != i64::MIN,
            StrategyError::BadConfig
        );

        let vault_key = ctx.accounts.vault.key();
        let col_ata = find_ata(ctx.remaining_accounts, vault_key, strategy.collateral_mint)?;
        let debt_ata = find_ata(ctx.remaining_accounts, vault_key, strategy.borrow_mint)?;
        let nft_ata = find_ata(
            ctx.remaining_accounts,
            vault_key,
            strategy.position_nft_mint,
        )?;
        let position = find_position(ctx.remaining_accounts, strategy)?;

        let col_before = token_amount(&col_ata)?;
        let debt_before = token_amount(&debt_ata)?;
        let supply_before = position_field(&position, POSITION_SUPPLY_OFF)?;
        let dust_before = position_field(&position, POSITION_DEBT_OFF)?;
        let others_before = snapshot_undeclared_atas(
            ctx.remaining_accounts,
            vault_key,
            &[col_ata.key(), debt_ata.key(), nft_ata.key()],
        );

        cpi_whitelisted(
            state,
            ctx.remaining_accounts,
            data,
            vault_key,
            state.vault_bump,
        )?;

        // Position accounting must match the declared deltas — this is what
        // stops an undeclared withdrawal or borrow.
        let supply_delta =
            position_field(&position, POSITION_SUPPLY_OFF)? as i128 - supply_before as i128;
        let dust_delta =
            position_field(&position, POSITION_DEBT_OFF)? as i128 - dust_before as i128;
        // Supply tolerance is tight (10 base units); debt tolerance is wider
        // (10k base units ≈ cent-level) because interest accrues per second.
        assert_declared(
            supply_delta,
            col_delta,
            10,
            StrategyError::BadCollateralFlow,
        )?;
        assert_declared(dust_delta, debt_delta, 10_000, StrategyError::BadDebtFlow)?;

        // Token flows must land in / leave from the vault's own ATAs:
        //   col_delta  > 0 deposit  -> vault collateral leaves by >= delta
        //   col_delta  < 0 withdraw -> vault collateral arrives by >= |delta| (fees tolerated)
        //   debt_delta > 0 borrow   -> vault borrow-mint arrives by >= delta
        //   debt_delta < 0 repay    -> vault borrow-mint leaves by >= |delta|
        assert_delta(
            &col_ata,
            col_before,
            -col_delta,
            StrategyError::BadCollateralFlow,
        )?;
        assert_delta(
            &debt_ata,
            debt_before,
            debt_delta,
            StrategyError::BadDebtFlow,
        )?;

        // Total debt is bound by the position's own accounting — the ceiling
        // is real, not a per-operation guess.
        let dust_after = position_field(&position, POSITION_DEBT_OFF)?;
        require!(
            dust_after <= strategy.max_debt,
            StrategyError::DebtCeilingExceeded
        );

        // The position NFT is still vault property and the ATAs are healthy.
        assert_token_amount(&nft_ata, 1, StrategyError::PositionMoved)?;
        assert_healthy_ata(&col_ata, vault_key)?;
        assert_healthy_ata(&debt_ata, vault_key)?;
        assert_healthy_ata(&nft_ata, vault_key)?;
        assert_undeclared_atas_intact(ctx.remaining_accounts, vault_key, &others_before)?;
        emit!(JlOperate {
            strategy: strategy_index,
            col_delta,
            debt_delta
        });
        Ok(())
    }

    /// Kamino supply/withdraw for the yield leg. Direction is declared;
    /// the vault's stable mint ATA must move accordingly.
    pub fn kamino_flow(
        ctx: Context<ProtocolOp>,
        strategy_index: u8,
        direction: FlowDirection,
        amount: u64,
        data: Vec<u8>,
    ) -> Result<()> {
        let state = &ctx.accounts.state;
        require!(!state.paused, StrategyError::Paused);
        require!(amount > 0, StrategyError::BadConfig);
        // `amount as i64` wraps above i64::MAX — reject before the delta math.
        require!(amount <= i64::MAX as u64, StrategyError::BadConfig);
        let strategy = state
            .strategies
            .get(strategy_index as usize)
            .ok_or(StrategyError::UnknownStrategy)?;
        let stable_mint = strategy.stable_mint;
        let vault_key = ctx.accounts.vault.key();

        let ata = find_ata(ctx.remaining_accounts, vault_key, stable_mint)?;
        let before = token_amount(&ata)?;
        let others_before =
            snapshot_undeclared_atas(ctx.remaining_accounts, vault_key, &[ata.key()]);

        cpi_whitelisted(
            state,
            ctx.remaining_accounts,
            data,
            vault_key,
            state.vault_bump,
        )?;

        let expected = match direction {
            FlowDirection::Supply => -(amount as i64),
            FlowDirection::Withdraw => amount as i64,
        };
        assert_delta(&ata, before, expected, StrategyError::BadStableFlow)?;
        assert_healthy_ata(&ata, vault_key)?;
        assert_undeclared_atas_intact(ctx.remaining_accounts, vault_key, &others_before)?;
        emit!(KaminoFlow {
            strategy: strategy_index,
            direction,
            amount
        });
        Ok(())
    }

    /// Swap between two whitelisted mints (Jupiter aggregator or any allowed
    /// venue). Input must leave the vault ATA by >= `amount`; output must
    /// land in the vault ATA by >= `min_out` — routing the output anywhere
    /// else simply fails the post-condition.
    pub fn swap(
        ctx: Context<ProtocolOp>,
        in_mint: Pubkey,
        out_mint: Pubkey,
        amount: u64,
        min_out: u64,
        data: Vec<u8>,
    ) -> Result<()> {
        let state = &mut ctx.accounts.state;
        require!(!state.paused, StrategyError::Paused);
        require!(
            state
                .allowed_mint_pairs
                .iter()
                .any(|p| p.from == in_mint && p.to == out_mint),
            StrategyError::MintPairNotAllowed
        );
        require!(amount > 0 && min_out > 0, StrategyError::BadConfig);
        // `amount as i64` wraps above i64::MAX — reject before the delta math.
        require!(amount <= i64::MAX as u64, StrategyError::BadConfig);
        // For pairs flagged near-equivalent (USDT↔USDG) the delegate cannot
        // set a floor below `amount * (1 - max_deviation_bps)` — a compromised
        // key could otherwise drain value via deliberately bad fills.
        let pair_index = state
            .allowed_mint_pairs
            .iter()
            .position(|p| p.from == in_mint && p.to == out_mint)
            .unwrap();
        let pair = &state.allowed_mint_pairs[pair_index];
        if pair.max_deviation_bps > 0 {
            let floor =
                (amount as u128).saturating_mul(10_000 - pair.max_deviation_bps as u128) / 10_000;
            require!(min_out as u128 >= floor, StrategyError::MinOutTooLow);
        }
        // Per-pair rolling cap: a compromised delegate can burn at most
        // daily_cap input units a day through bad fills before the guardian
        // pauses — bounded loss without any oracle dependency.
        let daily_cap = pair.daily_cap;
        let vault_key = ctx.accounts.vault.key();
        let in_ata = find_ata(ctx.remaining_accounts, vault_key, in_mint)?;
        let out_ata = find_ata(ctx.remaining_accounts, vault_key, out_mint)?;
        let in_before = token_amount(&in_ata)?;
        let out_before = token_amount(&out_ata)?;
        let others_before = snapshot_undeclared_atas(
            ctx.remaining_accounts,
            vault_key,
            &[in_ata.key(), out_ata.key()],
        );

        spend_window(
            state,
            amount,
            daily_cap,
            daily_cap,
            WindowKind::Swap(pair_index),
        )?;
        cpi_whitelisted(
            state,
            ctx.remaining_accounts,
            data,
            vault_key,
            state.vault_bump,
        )?;

        // Input must leave by exactly `amount` — a swap whose output goes to
        // an external account leaves the vault ATA short and fails; a swap
        // that pulls more than declared fails too.
        assert_delta_exact(
            &in_ata,
            in_before,
            -(amount as i64),
            StrategyError::BadSwapFlow,
        )?;
        assert_delta(
            &out_ata,
            out_before,
            min_out as i64,
            StrategyError::BadSwapOut,
        )?;
        assert_healthy_ata(&in_ata, vault_key)?;
        assert_healthy_ata(&out_ata, vault_key)?;
        assert_undeclared_atas_intact(ctx.remaining_accounts, vault_key, &others_before)?;
        emit!(Swap {
            in_mint,
            out_mint,
            amount,
            min_out
        });
        Ok(())
    }

    // -- exits ----------------------------------------------------------------

    /// SOL transfer to a whitelisted member, capped per transaction and over
    /// a rolling 24-hour window (hourly buckets — no midnight double-spend).
    pub fn payout(ctx: Context<Payout>, amount: u64) -> Result<()> {
        let state = &mut ctx.accounts.state;
        require!(!state.paused, StrategyError::Paused);
        require!(
            state
                .member_whitelist
                .contains(&ctx.accounts.destination.key()),
            StrategyError::NotWhitelisted
        );
        spend_allowance(state, amount)?;

        let seeds: &[&[u8]] = &[b"vault", &[state.vault_bump]];
        invoke_signed(
            &system_instruction::transfer(
                &ctx.accounts.vault.key(),
                &ctx.accounts.destination.key(),
                amount,
            ),
            &[
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.destination.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[seeds],
        )?;
        emit!(PayoutSent {
            destination: ctx.accounts.destination.key(),
            amount
        });
        Ok(())
    }

    /// SPL payout: destination must be the ATA of a whitelisted member for
    /// that mint, capped by the same rolling window (token base units).
    pub fn payout_token(ctx: Context<PayoutToken>, mint: Pubkey, amount: u64) -> Result<()> {
        let state = &mut ctx.accounts.state;
        require!(!state.paused, StrategyError::Paused);
        let vault_key = ctx.accounts.vault.key();
        let token_program =
            require_ata_owned(&ctx.accounts.source.to_account_info(), vault_key, mint)?;
        require!(
            ctx.accounts.token_program.key() == token_program,
            StrategyError::WrongAccount
        );
        require!(
            is_member_ata(state, &ctx.accounts.destination.key(), mint),
            StrategyError::NotWhitelisted
        );
        spend_token_allowance(state, amount)?;
        require!(
            ctx.accounts.mint_info.key() == mint,
            StrategyError::WrongAccount
        );
        let decimals = mint_decimals(&ctx.accounts.mint_info.to_account_info())?;

        let seeds: &[&[u8]] = &[b"vault", &[state.vault_bump]];
        invoke_signed(
            &spl_transfer_checked_ix(
                &token_program,
                ctx.accounts.source.key(),
                mint,
                ctx.accounts.destination.key(),
                vault_key,
                amount,
                decimals,
            ),
            &[
                ctx.accounts.source.to_account_info(),
                ctx.accounts.mint_info.to_account_info(),
                ctx.accounts.destination.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
            ],
            &[seeds],
        )?;
        emit!(TokenPayoutSent {
            destination: ctx.accounts.destination.key(),
            mint,
            amount
        });
        Ok(())
    }

    /// Issue share tokens (FSOL/FLiP) to a depositor, 1:1 in base units
    /// against the collateral recorded in `member_deposit.pending` — this is
    /// the guarantee that N deposited JUPSOL always yield N FSOL, no matter
    /// what the delegate does between the two transactions. The destination
    /// is derived from the deposit record itself, so the whitelist and the
    /// rolling payout caps do not apply: a depositor can only ever receive
    /// their own shares, and never more than they deposited.
    pub fn issue_shares(ctx: Context<IssueShares>, amount: u64) -> Result<()> {
        let state = &ctx.accounts.state;
        require!(!state.paused, StrategyError::Paused);
        let deposit = &mut ctx.accounts.member_deposit;
        let strategy = state
            .strategies
            .get(deposit.strategy as usize)
            .ok_or(StrategyError::UnknownStrategy)?;
        require!(amount > 0, StrategyError::BadConfig);
        require!(
            amount <= deposit.pending,
            StrategyError::InsufficientDeposit
        );
        let vault_key = ctx.accounts.vault.key();
        let token_program = require_ata_owned(
            &ctx.accounts.source.to_account_info(),
            vault_key,
            strategy.share_mint,
        )?;
        require!(
            ctx.accounts.token_program.key() == token_program,
            StrategyError::WrongAccount
        );
        require!(
            ctx.accounts.destination.key()
                == ata_address(deposit.member, strategy.share_mint, &token_program),
            StrategyError::WrongAccount
        );
        assert_healthy_ata(&ctx.accounts.source.to_account_info(), vault_key)?;
        require!(
            ctx.accounts.share_mint.key() == strategy.share_mint,
            StrategyError::WrongAccount
        );
        let decimals = mint_decimals(&ctx.accounts.share_mint.to_account_info())?;

        deposit.pending -= amount;
        let seeds: &[&[u8]] = &[b"vault", &[state.vault_bump]];
        invoke_signed(
            &spl_transfer_checked_ix(
                &token_program,
                ctx.accounts.source.key(),
                strategy.share_mint,
                ctx.accounts.destination.key(),
                vault_key,
                amount,
                decimals,
            ),
            &[
                ctx.accounts.source.to_account_info(),
                ctx.accounts.share_mint.to_account_info(),
                ctx.accounts.destination.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
            ],
            &[seeds],
        )?;
        emit!(SharesIssued {
            member: deposit.member,
            mint: strategy.share_mint,
            amount,
            remaining: deposit.pending,
        });
        Ok(())
    }

    /// Move yield to the treasury — the only delegate-callable exit besides
    /// capped member payouts. Destination is fixed in state, timelocked to
    /// change. Strategy-critical mints are never sweepable and the amount
    /// burns the same rolling token cap as member payouts: a compromised
    /// delegate can bleed the vault to the treasury (DoS / insolvency),
    /// so the flow is bounded too.
    pub fn sweep(ctx: Context<Sweep>, mint: Pubkey, amount: u64) -> Result<()> {
        let state = &mut ctx.accounts.state;
        require!(!state.paused, StrategyError::Paused);
        require!(amount > 0, StrategyError::BadConfig);
        for strategy in &state.strategies {
            require!(
                mint != strategy.collateral_mint
                    && mint != strategy.share_mint
                    && mint != strategy.borrow_mint
                    && mint != strategy.stable_mint
                    && mint != strategy.position_nft_mint,
                StrategyError::StrategyAssetNotSweepable
            );
        }
        spend_token_allowance(state, amount)?;
        let vault_key = ctx.accounts.vault.key();
        let treasury = state.treasury;
        let token_program =
            require_ata_owned(&ctx.accounts.source.to_account_info(), vault_key, mint)?;
        require!(
            ctx.accounts.token_program.key() == token_program,
            StrategyError::WrongAccount
        );
        let expected_dest = ata_address(treasury, mint, &token_program);
        require!(
            ctx.accounts.destination.key() == expected_dest,
            StrategyError::WrongAccount
        );
        require!(
            ctx.accounts.mint_info.key() == mint,
            StrategyError::WrongAccount
        );
        let decimals = mint_decimals(&ctx.accounts.mint_info.to_account_info())?;

        let seeds: &[&[u8]] = &[b"vault", &[state.vault_bump]];
        invoke_signed(
            &spl_transfer_checked_ix(
                &token_program,
                ctx.accounts.source.key(),
                mint,
                ctx.accounts.destination.key(),
                vault_key,
                amount,
                decimals,
            ),
            &[
                ctx.accounts.source.to_account_info(),
                ctx.accounts.mint_info.to_account_info(),
                ctx.accounts.destination.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
            ],
            &[seeds],
        )?;
        emit!(Swept { mint, amount });
        Ok(())
    }

    // -- guardian -----------------------------------------------------------

    /// Fast stop: the guardian can pause but never unpause — it exists to
    /// react to incidents, not to govern.
    pub fn guardian_pause(ctx: Context<GuardianOnly>) -> Result<()> {
        ctx.accounts.state.paused = true;
        emit!(Paused {});
        Ok(())
    }

    /// Guardian veto: cancel a scheduled config change inside its timelock
    /// window — the fast response to a compromised admin queuing a hostile
    /// whitelist, treasury, or delegate change. Scheduling a fresh change
    /// still needs the admin key, so the veto cannot be abused to create
    /// one either.
    pub fn guardian_cancel_pending(ctx: Context<GuardianOnly>) -> Result<()> {
        ctx.accounts.state.pending = None;
        emit!(PendingCanceled {});
        Ok(())
    }

    // -- admin ----------------------------------------------------------------

    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        ctx.accounts.state.paused = paused;
        if paused {
            emit!(Paused {});
        } else {
            emit!(Unpaused {});
        }
        Ok(())
    }

    /// Delegate rotation goes through the 48h timelock like every dangerous
    /// change: an instant swap would let a compromised admin hand the vault
    /// to their own key without a reaction window. For a compromised delegate
    /// the incident path is guardian_pause first, then the scheduled rotation
    /// applies while the vault is frozen.

    /// All dangerous configuration changes go through a 48h timelock so
    /// members have time to exit before new rules apply.
    pub fn schedule_config(ctx: Context<AdminOnly>, change: ConfigChange) -> Result<()> {
        match &change {
            ConfigChange::AllowedPrograms { programs } => validate_whitelists(programs, &[])?,
            ConfigChange::MemberWhitelist { members } => validate_whitelists(&[], members)?,
            ConfigChange::Strategies { strategies } => validate_strategies(strategies)?,
            ConfigChange::MintPairs { pairs } => validate_mint_pairs(pairs)?,
            ConfigChange::Caps {
                daily_lamports,
                tx_lamports,
                daily_token: _,
            } => {
                require!(tx_lamports <= daily_lamports, StrategyError::BadConfig);
            }
            ConfigChange::Treasury { treasury } => {
                require!(*treasury != Pubkey::default(), StrategyError::BadConfig);
            }
            ConfigChange::Delegate { delegate } => {
                require!(*delegate != Pubkey::default(), StrategyError::BadConfig);
            }
            ConfigChange::Admin { admin } => {
                require!(*admin != Pubkey::default(), StrategyError::BadConfig);
            }
        }
        let state = &mut ctx.accounts.state;
        // One pending change at a time: silently overwriting a scheduled
        // change hides it from monitors watching eta/event pairs (L-5).
        // The admin retracts their own pending via admin_cancel_pending.
        require!(state.pending.is_none(), StrategyError::PendingExists);
        let eta = Clock::get()?
            .unix_timestamp
            .saturating_add(ADMIN_TIMELOCK_SECS);
        state.pending = Some(PendingConfig {
            eta,
            change: change.clone(),
        });
        // The change itself is emitted for off-chain monitors — the guardian
        // watches this event to veto hostile changes inside the window.
        emit!(ConfigScheduled { eta, change });
        Ok(())
    }

    pub fn apply_config(ctx: Context<AdminOnly>) -> Result<()> {
        let state = &mut ctx.accounts.state;
        let pending = state.pending.take().ok_or(StrategyError::NothingPending)?;
        require!(
            Clock::get()?.unix_timestamp >= pending.eta,
            StrategyError::TimelockNotReady
        );
        match pending.change {
            ConfigChange::AllowedPrograms { programs } => state.allowed_programs = programs,
            ConfigChange::MemberWhitelist { members } => state.member_whitelist = members,
            ConfigChange::Treasury { treasury } => state.treasury = treasury,
            ConfigChange::Delegate { delegate } => {
                state.delegate = delegate;
                emit!(DelegateChanged { delegate });
            }
            ConfigChange::Caps {
                daily_lamports,
                tx_lamports,
                daily_token,
            } => {
                state.daily_cap_lamports = daily_lamports;
                state.tx_cap_lamports = tx_lamports;
                state.daily_token_cap = daily_token;
            }
            ConfigChange::Strategies { strategies } => {
                for strategy in &strategies {
                    require!(
                        state.allowed_programs.contains(&strategy.vaults_program),
                        StrategyError::ProgramNotAllowed
                    );
                }
                state.strategies = strategies;
            }
            ConfigChange::MintPairs { pairs } => state.allowed_mint_pairs = pairs,
            // The handover is only PROPOSED here — the new admin must still
            // sign accept_admin. Routing through the 48h timelock (M-5)
            // closes the instant-takeover path a compromised admin key had.
            ConfigChange::Admin { admin } => {
                state.proposed_admin = Some(admin);
                emit!(AdminProposed { new_admin: admin });
            }
        }
        emit!(ConfigApplied {});
        Ok(())
    }

    /// Retract a self-scheduled change — the admin's own escape from
    /// `pending.is_none()` without needing the guardian's veto.
    pub fn admin_cancel_pending(ctx: Context<AdminOnly>) -> Result<()> {
        ctx.accounts.state.pending = None;
        emit!(PendingCanceled {});
        Ok(())
    }

    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        let state = &mut ctx.accounts.state;
        let proposed = state.proposed_admin.ok_or(StrategyError::NothingPending)?;
        require!(
            proposed == ctx.accounts.caller.key(),
            StrategyError::NotProposedAdmin
        );
        state.admin = proposed;
        state.proposed_admin = None;
        emit!(AdminAccepted { admin: proposed });
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/// Mint-pair sanity: bounded size, no self-pair, deviation ≤ 100% (bps is
/// u16 — an over-10_000 value would underflow the floor math), and no
/// duplicate from→to (dups would stack the per-pair daily caps).
fn validate_mint_pairs(pairs: &[MintPair]) -> Result<()> {
    require!(pairs.len() <= MAX_MINT_PAIRS, StrategyError::BadConfig);
    for (i, p) in pairs.iter().enumerate() {
        require!(p.from != p.to, StrategyError::BadConfig);
        require!(p.max_deviation_bps <= 10_000, StrategyError::BadConfig);
        require!(
            !pairs[..i].iter().any(|q| q.from == p.from && q.to == p.to),
            StrategyError::BadConfig
        );
    }
    Ok(())
}

/// Strategy-config sanity: bounded size and every pubkey set. The
/// vaults_program whitelist check happens at apply time so programs can be
/// scheduled together with the strategy that uses them.
fn validate_strategies(strategies: &[StrategyConfig]) -> Result<()> {
    require!(strategies.len() <= MAX_STRATEGIES, StrategyError::BadConfig);
    for s in strategies {
        require!(
            s.vaults_program != Pubkey::default(),
            StrategyError::BadConfig
        );
        require!(
            s.collateral_mint != Pubkey::default(),
            StrategyError::BadConfig
        );
        require!(s.share_mint != Pubkey::default(), StrategyError::BadConfig);
        require!(s.collateral_mint != s.share_mint, StrategyError::BadConfig);
    }
    Ok(())
}

fn validate_whitelists(programs: &[Pubkey], members: &[Pubkey]) -> Result<()> {
    require!(
        programs.len() <= MAX_ALLOWED_PROGRAMS,
        StrategyError::WhitelistTooLarge
    );
    require!(
        members.len() <= MAX_MEMBERS,
        StrategyError::WhitelistTooLarge
    );
    // Never allow the strategy program itself as a CPI target.
    require!(
        !programs.contains(&crate::ID),
        StrategyError::ProgramNotAllowed
    );
    // Generic transfer/account programs are never valid CPI targets: they can
    // move vault assets to arbitrary accounts with no protocol-side witness
    // for the post-conditions to check against.
    for banned in [TOKEN_PROGRAM_ID, ATA_PROGRAM_ID, SYSTEM_PROGRAM_ID] {
        require!(
            !programs.contains(&banned),
            StrategyError::ProgramNotAllowed
        );
    }
    require!(
        !members.contains(&Pubkey::default()),
        StrategyError::BadConfig
    );
    for (i, p) in programs.iter().enumerate() {
        require!(!programs[..i].contains(p), StrategyError::BadConfig);
    }
    for (i, m) in members.iter().enumerate() {
        require!(!members[..i].contains(m), StrategyError::BadConfig);
    }
    Ok(())
}

/// Replays a delegate-supplied instruction on a whitelisted program with the
/// vault PDA as the only additional signer. Convention: the callee program
/// account is the LAST remaining account; it is not forwarded as a data
/// account of the inner instruction. Delegate signatures are not forwarded:
/// only the vault signs inside the CPI.
fn cpi_whitelisted(
    state: &StrategyState,
    remaining: &[AccountInfo],
    data: Vec<u8>,
    vault_key: Pubkey,
    vault_bump: u8,
) -> Result<()> {
    let (program_info, data_accounts) = remaining
        .split_last()
        .ok_or(StrategyError::MissingAccounts)?;
    let program_id = program_info.key();
    require!(
        state.allowed_programs.contains(&program_id),
        StrategyError::ProgramNotAllowed
    );
    let metas: Vec<AccountMeta> = data_accounts
        .iter()
        .map(|info| AccountMeta {
            pubkey: info.key(),
            is_signer: info.key() == vault_key,
            is_writable: info.is_writable,
        })
        .collect();
    require!(
        metas.iter().any(|m| m.pubkey == vault_key && m.is_signer),
        StrategyError::VaultMustSign
    );
    // Vault invariants: the PDA is a dataless System-owned lamport account
    // that also holds the SOL payout pool. A whitelisted program — or any
    // program it chains into, since signer privilege propagates — could
    // otherwise siphon the lamports via system::transfer or hijack the
    // account via system::assign/allocate. Token post-conditions see none
    // of that, so lamports / owner / data_len are asserted around the call.
    let vault_info = data_accounts
        .iter()
        .find(|info| info.key() == vault_key)
        .ok_or(StrategyError::MissingAccounts)?;
    require!(
        *vault_info.owner == SYSTEM_PROGRAM_ID,
        StrategyError::WrongAccount
    );
    require!(vault_info.data_len() == 0, StrategyError::WrongAccount);
    let vault_lamports_before = vault_info.lamports();
    invoke_signed(
        &Instruction {
            program_id,
            accounts: metas,
            data,
        },
        remaining,
        &[&[b"vault", &[vault_bump]]],
    )?;
    require!(
        vault_info.lamports() >= vault_lamports_before,
        StrategyError::VaultDrained
    );
    require!(
        *vault_info.owner == SYSTEM_PROGRAM_ID,
        StrategyError::VaultDrained
    );
    require!(vault_info.data_len() == 0, StrategyError::VaultDrained);
    Ok(())
}

/// ATA address of `owner` for `mint` under a given token program — SPL Token
/// or Token-2022, selected by the caller.
fn ata_address(owner: Pubkey, mint: Pubkey, token_program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[owner.as_ref(), token_program.as_ref(), mint.as_ref()],
        &ATA_PROGRAM_ID,
    )
    .0
}

/// Proves `info` is the canonical ATA of `owner` for `mint` and returns its
/// token program. The account's own program owner selects the derivation —
/// a Token-2022 ATA can only exist under Token-2022, so checking `info.owner`
/// against the matched program makes a look-alike impossible.
fn require_ata_owned(info: &AccountInfo, owner: Pubkey, mint: Pubkey) -> Result<Pubkey> {
    let token_program = *info.owner;
    require!(
        token_program == TOKEN_PROGRAM_ID || token_program == TOKEN_2022_PROGRAM_ID,
        StrategyError::WrongAccount
    );
    require!(
        info.key() == ata_address(owner, mint, &token_program),
        StrategyError::WrongAccount
    );
    Ok(token_program)
}

/// Find the vault's ATA for `mint` inside the remaining accounts and return
/// its raw data — the delegate proves the account belongs to the vault by
/// construction, not by index.
fn find_ata<'info>(
    remaining: &'info [AccountInfo<'info>],
    vault: Pubkey,
    mint: Pubkey,
) -> Result<AccountInfo<'info>> {
    for token_program in [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID] {
        let expected = ata_address(vault, mint, &token_program);
        if let Some(info) = remaining.iter().find(|info| info.key() == expected) {
            return Ok(info.clone());
        }
    }
    Err(StrategyError::MissingAccounts.into())
}

/// Fluid position PDA: seeds `["position", vault_id u16, position_id u32]`
/// under the vaults program.
fn position_pda(strategy: &StrategyConfig) -> Pubkey {
    Pubkey::find_program_address(
        &[
            b"position",
            &(strategy.vault_id as u16).to_le_bytes(),
            &strategy.position_id.to_le_bytes(),
        ],
        &strategy.vaults_program,
    )
    .0
}

/// Locate the configured position account in the remaining accounts and
/// prove it is the strategy's position (right PDA, right program, right
/// position mint inside the data).
fn find_position<'info>(
    remaining: &'info [AccountInfo<'info>],
    strategy: &StrategyConfig,
) -> Result<AccountInfo<'info>> {
    let expected = position_pda(strategy);
    let position = remaining
        .iter()
        .find(|info| info.key() == expected)
        .cloned()
        .ok_or(StrategyError::MissingAccounts)?;
    require!(
        position.owner == &strategy.vaults_program,
        StrategyError::WrongAccount
    );
    {
        let data = position.try_borrow_data()?;
        require!(data.len() >= POSITION_LEN, StrategyError::WrongAccount);
        require!(
            Pubkey::try_from(&data[POSITION_MINT_OFF..POSITION_MINT_OFF + 32])
                .map_err(|_| StrategyError::WrongAccount)?
                == strategy.position_nft_mint,
            StrategyError::WrongAccount
        );
    }
    Ok(position)
}

fn position_field(position: &AccountInfo, offset: usize) -> Result<u64> {
    let data = position.try_borrow_data()?;
    require!(data.len() >= POSITION_LEN, StrategyError::WrongAccount);
    Ok(u64::from_le_bytes(
        data[offset..offset + 8].try_into().unwrap(),
    ))
}

/// SPL token balance if `info` is a token account owned by `vault`, else None.
fn vault_ata_amount(info: &AccountInfo, vault: &Pubkey) -> Option<u64> {
    if info.owner != &TOKEN_PROGRAM_ID && info.owner != &TOKEN_2022_PROGRAM_ID {
        return None;
    }
    let data = info.try_borrow_data().ok()?;
    if data.len() < 165 {
        return None;
    }
    if Pubkey::try_from(&data[TA_OWNER..TA_OWNER + 32]).ok()? != *vault {
        return None;
    }
    Some(u64::from_le_bytes(
        data[TA_AMOUNT..TA_AMOUNT + 8].try_into().ok()?,
    ))
}

/// Snapshot every vault-owned token account passed in `remaining` that the
/// caller does not declare — the declared ATAs are asserted individually.
fn snapshot_undeclared_atas(
    remaining: &[AccountInfo],
    vault: Pubkey,
    exempt: &[Pubkey],
) -> Vec<(usize, u64)> {
    remaining
        .iter()
        .enumerate()
        .filter(|(_, info)| !exempt.contains(&info.key()))
        .filter_map(|(i, info)| vault_ata_amount(info, &vault).map(|amt| (i, amt)))
        .collect()
}

/// Post-condition on the ATAs the instruction did not declare: their balance
/// must not have decreased and they must still be healthy vault accounts.
/// This is what stops a crafted whitelisted CPI from routing an undeclared
/// vault token (or a delegate/close authority) out of the vault.
fn assert_undeclared_atas_intact(
    remaining: &[AccountInfo],
    vault: Pubkey,
    before: &[(usize, u64)],
) -> Result<()> {
    for (i, amt) in before {
        let info = &remaining[*i];
        require!(
            token_amount(info)? >= *amt,
            StrategyError::UndeclaredOutflow
        );
        assert_healthy_ata(info, vault)?;
    }
    // Vault ATAs CREATED during the CPI are not in `before` — a whitelisted
    // program could otherwise leave one behind with a delegate or close
    // authority set, a deferred drain the snapshot would never see.
    for (i, info) in remaining.iter().enumerate() {
        if before.iter().all(|(j, _)| *j != i) && vault_ata_amount(info, &vault).is_some() {
            assert_healthy_ata(info, vault)?;
        }
    }
    Ok(())
}

/// Declared delta must match the actual on-chain delta within tolerance —
/// a delegate cannot hide an operation by declaring zero. `abs_floor` covers
/// rounding and, on the debt side, interest accrued between build and land.
fn assert_declared(actual: i128, declared: i64, abs_floor: u64, err: StrategyError) -> Result<()> {
    let declared = declared as i128;
    let tolerance = (declared.unsigned_abs() * DELTA_TOLERANCE_NUM as u128
        / DELTA_TOLERANCE_DEN as u128)
        .max(abs_floor as u128) as i128;
    if (actual - declared).abs() > tolerance {
        return Err(err.into());
    }
    Ok(())
}

/// Raw balance of an SPL token account. Fails if the account is not a real
/// token account (wrong owner program or too small).
fn token_amount(ata: &AccountInfo) -> Result<u64> {
    require!(
        ata.owner == &TOKEN_PROGRAM_ID || ata.owner == &TOKEN_2022_PROGRAM_ID,
        StrategyError::WrongAccount
    );
    let data = ata.try_borrow_data()?;
    require!(data.len() >= 165, StrategyError::WrongAccount);
    Ok(u64::from_le_bytes(
        data[TA_AMOUNT..TA_AMOUNT + 8].try_into().unwrap(),
    ))
}

fn assert_token_amount(ata: &AccountInfo, expected: u64, err: StrategyError) -> Result<()> {
    if token_amount(ata)? != expected {
        return Err(err.into());
    }
    Ok(())
}

/// Post-condition: the ATA balance must have changed by `expected` or more
/// in that direction (negative = outflow, positive = inflow).
fn assert_delta(ata: &AccountInfo, before: u64, expected: i64, err: StrategyError) -> Result<()> {
    let delta = token_amount(ata)? as i128 - before as i128;
    let ok = if expected >= 0 {
        delta >= expected as i128
    } else {
        delta <= expected as i128
    };
    if !ok {
        return Err(err.into());
    }
    Ok(())
}

/// Strict version: the delta must equal `expected` exactly.
fn assert_delta_exact(
    ata: &AccountInfo,
    before: u64,
    expected: i64,
    err: StrategyError,
) -> Result<()> {
    let delta = token_amount(ata)? as i128 - before as i128;
    if delta != expected as i128 {
        return Err(err.into());
    }
    Ok(())
}

/// A healthy vault ATA: owned by the vault PDA, no delegate, no close
/// authority — checked after every CPI so nothing can hijack the account.
fn assert_healthy_ata(ata: &AccountInfo, vault: Pubkey) -> Result<()> {
    require!(
        ata.owner == &TOKEN_PROGRAM_ID || ata.owner == &TOKEN_2022_PROGRAM_ID,
        StrategyError::WrongAccount
    );
    let data = ata.try_borrow_data()?;
    require!(data.len() >= 165, StrategyError::WrongAccount);
    require!(
        Pubkey::try_from(&data[TA_OWNER..TA_OWNER + 32])
            .map_err(|_| StrategyError::WrongAccount)?
            == vault,
        StrategyError::WrongAccount
    );
    require!(
        data[TA_STATE] == TA_INITIALIZED,
        StrategyError::WrongAccount
    );
    require!(
        u32::from_le_bytes(
            data[TA_DELEGATE_TAG..TA_DELEGATE_TAG + 4]
                .try_into()
                .unwrap()
        ) == 0,
        StrategyError::AtaHijacked
    );
    require!(
        u32::from_le_bytes(
            data[TA_CLOSE_AUTH_TAG..TA_CLOSE_AUTH_TAG + 4]
                .try_into()
                .unwrap()
        ) == 0,
        StrategyError::AtaHijacked
    );
    Ok(())
}

/// Whether `destination` is the ATA of a whitelisted member for `mint`.
fn is_member_ata(state: &StrategyState, destination: &Pubkey, mint: Pubkey) -> bool {
    state.member_whitelist.iter().any(|member| {
        [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]
            .iter()
            .any(|token_program| ata_address(*member, mint, token_program) == *destination)
    })
}

/// SPL Mint decimals: mint_authority COption(36) + supply u64 + decimals u8
/// at offset 44 — identical base layout on Token and Token-2022 (extension
/// data lives past byte 82). `is_initialized` at 45 must be set.
fn mint_decimals(mint: &AccountInfo) -> Result<u8> {
    require!(
        mint.owner == &TOKEN_PROGRAM_ID || mint.owner == &TOKEN_2022_PROGRAM_ID,
        StrategyError::WrongAccount
    );
    let data = mint.try_borrow_data()?;
    require!(data.len() >= 82, StrategyError::WrongAccount);
    require!(data[45] != 0, StrategyError::WrongAccount);
    Ok(data[44])
}

/// TransferChecked — required for Token-2022 mints carrying a transfer-fee
/// extension (plain Transfer is rejected there) and strictly safer: the mint
/// account authenticates the token program and the decimals guard the amount.
fn spl_transfer_checked_ix(
    token_program: &Pubkey,
    source: Pubkey,
    mint: Pubkey,
    destination: Pubkey,
    authority: Pubkey,
    amount: u64,
    decimals: u8,
) -> Instruction {
    let mut data = Vec::with_capacity(10);
    data.push(12u8); // TransferChecked — same discriminator on SPL Token and Token-2022.
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(decimals);
    Instruction {
        program_id: *token_program,
        accounts: vec![
            AccountMeta::new(source, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new(destination, false),
            AccountMeta::new_readonly(authority, true),
        ],
        data,
    }
}

/// ATA program `CreateIdempotent` — creates the account if missing, no-ops
/// otherwise. Lets `deposit` guarantee the member's share ATA exists in the
/// same transaction, so the delegate never has to fund member rent.
fn create_ata_ix(
    payer: Pubkey,
    ata: Pubkey,
    owner: Pubkey,
    mint: Pubkey,
    token_program: &Pubkey,
) -> Instruction {
    Instruction {
        program_id: ATA_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(payer, true),
            AccountMeta::new(ata, false),
            AccountMeta::new_readonly(owner, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
            AccountMeta::new_readonly(*token_program, false),
        ],
        data: vec![1u8], // CreateIdempotent
    }
}

/// Rolling-window allowance for SOL payouts (hourly buckets).
fn spend_allowance(state: &mut StrategyState, amount: u64) -> Result<()> {
    let tx_cap = state.tx_cap_lamports;
    let window_cap = state.daily_cap_lamports;
    spend_window(state, amount, tx_cap, window_cap, WindowKind::Sol)
}

fn spend_token_allowance(state: &mut StrategyState, amount: u64) -> Result<()> {
    let cap = state.daily_token_cap;
    spend_window(state, amount, cap, cap, WindowKind::Token)
}

enum WindowKind {
    Sol,
    Token,
    /// Per-mint-pair swap allowance — bounds the daily input volume a
    /// compromised delegate can route through deliberately bad fills.
    Swap(usize),
}

fn spend_window(
    state: &mut StrategyState,
    amount: u64,
    tx_cap: u64,
    window_cap: u64,
    window: WindowKind,
) -> Result<()> {
    require!(amount <= tx_cap, StrategyError::TxCapExceeded);
    let now = Clock::get()?.unix_timestamp;
    let hour = now.div_euclid(HOUR_SECS);
    // Expire buckets whose hour fell out of the rolling 24h window — hours
    // [window_start_hour, hour-24]. window_start_hour is the oldest hour that
    // may still hold counted spend; clearing only the stale range keeps the
    // last 23h intact (clearing elapsed buckets instead would wipe recent
    // spend and degrade the cap to a per-hour limit).
    if state.window_start_hour == 0 {
        state.window_start_hour = hour;
    }
    let elapsed = hour.saturating_sub(state.window_start_hour);
    // elapsed < 24 → nothing is stale. max(0) BEFORE the usize cast —
    // a negative i64 would wrap to ~2^64 and loop forever.
    let stale = elapsed.saturating_sub(23).clamp(0, 24) as usize;
    if stale > 0 {
        for i in 0..stale {
            let idx = ((state.window_start_hour + i as i64) % 24) as usize;
            state.spent_sol_hourly[idx] = 0;
            state.spent_token_hourly[idx] = 0;
            for pair in 0..MAX_MINT_PAIRS {
                state.spent_swap_hourly[pair * 24 + idx] = 0;
            }
        }
        state.window_start_hour = state.window_start_hour.saturating_add(stale as i64);
    }
    let buckets: &mut [u64] = match window {
        WindowKind::Sol => &mut state.spent_sol_hourly,
        WindowKind::Token => &mut state.spent_token_hourly,
        WindowKind::Swap(pair) => &mut state.spent_swap_hourly[pair * 24..(pair + 1) * 24],
    };
    let spent: u64 = buckets.iter().fold(0u64, |a, b| a.saturating_add(*b));
    require!(
        spent.saturating_add(amount) <= window_cap,
        StrategyError::DailyCapExceeded
    );
    let idx = (hour % 24) as usize;
    buckets[idx] = buckets[idx].saturating_add(amount);
    Ok(())
}

// ---------------------------------------------------------------------------
// accounts & state
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeArgs {
    pub admin: Pubkey,
    pub delegate: Pubkey,
    pub guardian: Pubkey,
    pub treasury: Pubkey,
    pub allowed_programs: Vec<Pubkey>,
    pub member_whitelist: Vec<Pubkey>,
    pub strategies: Vec<StrategyConfig>,
    pub allowed_mint_pairs: Vec<MintPair>,
    pub daily_cap_lamports: u64,
    pub tx_cap_lamports: u64,
    pub daily_token_cap: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct StrategyConfig {
    /// Jupiter Lend vault id (52 = JUPSOL/USDT, 50 = JLP/USDT).
    pub vault_id: u64,
    /// Position id — the NFT id of the leveraged position (124, 161…).
    pub position_id: u32,
    /// Jupiter Lend vaults program this position lives on.
    pub vaults_program: Pubkey,
    /// Position NFT mint held by the strategy vault.
    pub position_nft_mint: Pubkey,
    /// Collateral mint (JUPSOL or JLP).
    pub collateral_mint: Pubkey,
    /// Borrow mint (USDT).
    pub borrow_mint: Pubkey,
    /// Yield mint supplied to Kamino (USDG).
    pub stable_mint: Pubkey,
    /// Share token minted back to depositors (FSOL / FLIP), 1:1 in base units
    /// with the collateral mint — enforced by `issue_shares` against
    /// `member_deposit.pending`.
    pub share_mint: Pubkey,
    /// Hard ceiling on total position debt (post-op dustDebtAmount must
    /// stay under it), in borrow-mint base units.
    pub max_debt: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct MintPair {
    pub from: Pubkey,
    pub to: Pubkey,
    /// Maximum allowed input/output deviation in basis points. For
    /// near-equivalent stables (USDT↔USDG) set ~50: `swap` then requires
    /// `min_out >= amount * (1 - max_deviation_bps/10000)` so a compromised
    /// delegate cannot route a deliberately bad fill. 0 = no bound.
    pub max_deviation_bps: u16,
    /// Maximum input units swappable per rolling 24h on this pair. Bounds
    /// what a compromised delegate can burn through deliberately bad fills
    /// before the guardian pauses — 0 disables the pair.
    pub daily_cap: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum FlowDirection {
    Supply,
    Withdraw,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub enum ConfigChange {
    AllowedPrograms {
        programs: Vec<Pubkey>,
    },
    MemberWhitelist {
        members: Vec<Pubkey>,
    },
    Treasury {
        treasury: Pubkey,
    },
    Delegate {
        delegate: Pubkey,
    },
    Caps {
        daily_lamports: u64,
        tx_lamports: u64,
        daily_token: u64,
    },
    Strategies {
        strategies: Vec<StrategyConfig>,
    },
    MintPairs {
        pairs: Vec<MintPair>,
    },
    // Appended last: borsh encodes the variant index, so inserting earlier
    // would renumber every existing variant.
    Admin {
        admin: Pubkey,
    },
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PendingConfig {
    pub eta: i64,
    pub change: ConfigChange,
}

#[account]
pub struct StrategyState {
    pub admin: Pubkey,
    pub delegate: Pubkey,
    pub guardian: Pubkey,
    pub treasury: Pubkey,
    pub paused: bool,
    pub allowed_programs: Vec<Pubkey>,
    pub member_whitelist: Vec<Pubkey>,
    pub strategies: Vec<StrategyConfig>,
    pub allowed_mint_pairs: Vec<MintPair>,
    pub daily_cap_lamports: u64,
    pub tx_cap_lamports: u64,
    pub daily_token_cap: u64,
    /// Rolling 24h windows, hourly buckets — SOL and tokens are accounted
    /// separately so a SOL payout can never eat the token budget.
    pub spent_sol_hourly: [u64; 24],
    pub spent_token_hourly: [u64; 24],
    /// Per-mint-pair swap input spend, indexed `pair_index * 24 + hour % 24`.
    /// A Vec (heap) keeps the 3KB of buckets off the 4KB BPF stack.
    pub spent_swap_hourly: Vec<u64>,
    pub window_start_hour: i64,
    pub pending: Option<PendingConfig>,
    pub proposed_admin: Option<Pubkey>,
    pub vault_bump: u8,
    pub bump: u8,
}

impl StrategyState {
    // discriminator + fixed fields + max-size vecs
    pub const SPACE: usize = 8
        + 32 * 4
        + 1
        + 4 + 32 * MAX_ALLOWED_PROGRAMS
        + 4 + 32 * MAX_MEMBERS
        + 4 + (8 + 4 + 32 * 4 + 32 + 32 + 32 + 8) * MAX_STRATEGIES
        + 4 + 74 * MAX_MINT_PAIRS
        + 8 + 8 + 8
        + 8 * 48
        + 4 + 8 * 24 * MAX_MINT_PAIRS
        + 8
        + 1 + 8 + 1 + 4 + 32 * MAX_MEMBERS // pending worst-case = MemberWhitelist variant
        + 1 + 32
        + 1 + 1
        + 64; // headroom
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = StrategyState::SPACE,
        seeds = [b"state"],
        bump,
    )]
    pub state: Box<Account<'info, StrategyState>>,
    /// CHECK: the strategy vault PDA that owns positions and token accounts.
    #[account(seeds = [b"vault"], bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: this program's executable account — verified against crate::ID.
    #[account(address = crate::ID)]
    pub this_program: UncheckedAccount<'info>,
    /// CHECK: the program's ProgramData account (proves upgrade authority).
    /// Owner and PDA address verified in the handler.
    #[account(owner = anchor_lang::solana_program::bpf_loader_upgradeable::ID)]
    pub program_data: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ProtocolOp<'info> {
    #[account(constraint = caller.key() == state.delegate @ StrategyError::NotDelegate)]
    pub caller: Signer<'info>,
    #[account(mut, seeds = [b"state"], bump = state.bump)]
    pub state: Box<Account<'info, StrategyState>>,
    /// CHECK: validated by seeds; becomes the forced signer in the CPI.
    #[account(seeds = [b"vault"], bump = state.vault_bump)]
    pub vault: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Payout<'info> {
    #[account(constraint = caller.key() == state.delegate @ StrategyError::NotDelegate)]
    pub caller: Signer<'info>,
    #[account(mut, seeds = [b"state"], bump = state.bump)]
    pub state: Box<Account<'info, StrategyState>>,
    /// CHECK: validated by seeds.
    #[account(mut, seeds = [b"vault"], bump = state.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: must be in `member_whitelist` — enforced in the handler.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PayoutToken<'info> {
    #[account(constraint = caller.key() == state.delegate @ StrategyError::NotDelegate)]
    pub caller: Signer<'info>,
    #[account(mut, seeds = [b"state"], bump = state.bump)]
    pub state: Box<Account<'info, StrategyState>>,
    /// CHECK: validated by seeds.
    #[account(mut, seeds = [b"vault"], bump = state.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: must be the vault ATA for `mint` — enforced in the handler.
    #[account(mut)]
    pub source: UncheckedAccount<'info>,
    /// CHECK: must be a member's ATA for `mint` — enforced in the handler.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    /// CHECK: SPL Token or Token-2022 program — verified against `source` in
    /// the handler (the mint's owner decides which).
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: the mint account itself — key verified against the `mint` arg;
    /// decimals read for TransferChecked.
    pub mint_info: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Sweep<'info> {
    #[account(constraint = caller.key() == state.delegate @ StrategyError::NotDelegate)]
    pub caller: Signer<'info>,
    #[account(mut, seeds = [b"state"], bump = state.bump)]
    pub state: Box<Account<'info, StrategyState>>,
    /// CHECK: validated by seeds.
    #[account(mut, seeds = [b"vault"], bump = state.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: must be the vault ATA for `mint`.
    #[account(mut)]
    pub source: UncheckedAccount<'info>,
    /// CHECK: must be the treasury ATA for `mint`.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    /// CHECK: SPL Token or Token-2022 program — verified against `source`.
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: the mint account itself — key verified against the `mint` arg;
    /// decimals read for TransferChecked.
    pub mint_info: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct GuardianOnly<'info> {
    #[account(constraint = caller.key() == state.guardian @ StrategyError::NotGuardian)]
    pub caller: Signer<'info>,
    #[account(mut, seeds = [b"state"], bump = state.bump)]
    pub state: Box<Account<'info, StrategyState>>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(constraint = caller.key() == state.admin @ StrategyError::NotAdmin)]
    pub caller: Signer<'info>,
    #[account(mut, seeds = [b"state"], bump = state.bump)]
    pub state: Box<Account<'info, StrategyState>>,
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub caller: Signer<'info>,
    #[account(mut, seeds = [b"state"], bump = state.bump)]
    pub state: Box<Account<'info, StrategyState>>,
}

/// Member-facing deposit: the member signs, collateral moves member ATA →
/// vault ATA, `member_deposit` records what they are owed in share units.
#[derive(Accounts)]
#[instruction(strategy_index: u8)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub member: Signer<'info>,
    #[account(seeds = [b"state"], bump = state.bump)]
    pub state: Box<Account<'info, StrategyState>>,
    /// CHECK: mint binding is verified against the strategy inside the handler.
    #[account(mut)]
    pub member_ata: UncheckedAccount<'info>,
    /// CHECK: derived and checked inside the handler.
    #[account(mut, seeds = [b"vault"], bump = state.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: must be the vault ATA for the strategy collateral mint (checked).
    #[account(mut)]
    pub vault_ata: UncheckedAccount<'info>,
    /// CHECK: must equal state.delegate — receives the member tip (checked).
    #[account(mut)]
    pub delegate: UncheckedAccount<'info>,
    /// CHECK: must equal the strategy's share_mint (checked in handler).
    pub share_mint: UncheckedAccount<'info>,
    /// CHECK: the member's share ATA — created idempotently by this ix so the
    /// member (not the delegate) pays its rent (checked in handler).
    #[account(mut)]
    pub member_share_ata: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = member,
        space = MemberDeposit::SPACE,
        seeds = [b"deposit", member.key().as_ref(), &[strategy_index]],
        bump,
    )]
    pub member_deposit: Box<Account<'info, MemberDeposit>>,
    /// CHECK: token program of the collateral ATA — SPL Token or Token-2022,
    /// verified against `member_ata` in the handler.
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: token program of the share mint — must equal `share_mint.owner`
    /// (verified in the handler); required to create the member's share ATA.
    pub share_token_program: UncheckedAccount<'info>,
    /// CHECK: pinned to the system program id.
    #[account(address = SYSTEM_PROGRAM_ID)]
    pub system_program: UncheckedAccount<'info>,
    /// CHECK: pinned to the canonical ATA program id.
    #[account(address = ATA_PROGRAM_ID)]
    pub ata_program: UncheckedAccount<'info>,
    /// CHECK: the collateral mint account — key verified against the
    /// strategy inside the handler; decimals read for TransferChecked.
    pub collateral_mint: UncheckedAccount<'info>,
}

/// Delegate-issued share payout tied to a recorded deposit — no whitelist
/// needed: the destination is derived from `member_deposit.member` itself.
#[derive(Accounts)]
pub struct IssueShares<'info> {
    #[account(constraint = caller.key() == state.delegate @ StrategyError::NotDelegate)]
    pub caller: Signer<'info>,
    #[account(seeds = [b"state"], bump = state.bump)]
    pub state: Box<Account<'info, StrategyState>>,
    /// CHECK: PDA authority over the vault ATAs.
    #[account(mut, seeds = [b"vault"], bump = state.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [b"deposit", member_deposit.member.as_ref(), &[member_deposit.strategy]],
        bump = member_deposit.bump,
    )]
    pub member_deposit: Box<Account<'info, MemberDeposit>>,
    /// CHECK: must be the vault ATA for the strategy share mint (checked).
    #[account(mut)]
    pub source: UncheckedAccount<'info>,
    /// CHECK: must be the depositor ATA for the strategy share mint (checked).
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    /// CHECK: SPL Token or Token-2022 — verified against `source`.
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: the share mint account — key verified against the strategy in
    /// the handler; decimals read for TransferChecked.
    pub share_mint: UncheckedAccount<'info>,
}

/// Per-member pending deposit: collateral base units owed back as share
/// tokens. Created on `deposit`, drained by `issue_shares` — the on-chain
/// witness that makes the 1:1 issuance enforceable.
#[account]
pub struct MemberDeposit {
    pub member: Pubkey,
    pub strategy: u8,
    pub pending: u64,
    pub bump: u8,
}

impl MemberDeposit {
    pub const SPACE: usize = 8 + 32 + 1 + 8 + 1;
}

// ---------------------------------------------------------------------------
// events & errors
// ---------------------------------------------------------------------------

#[event]
pub struct Initialized {
    pub admin: Pubkey,
    pub delegate: Pubkey,
}
#[event]
pub struct JlOperate {
    pub strategy: u8,
    pub col_delta: i64,
    pub debt_delta: i64,
}
#[event]
pub struct KaminoFlow {
    pub strategy: u8,
    pub direction: FlowDirection,
    pub amount: u64,
}
#[event]
pub struct Swap {
    pub in_mint: Pubkey,
    pub out_mint: Pubkey,
    pub amount: u64,
    pub min_out: u64,
}
#[event]
pub struct PayoutSent {
    pub destination: Pubkey,
    pub amount: u64,
}
#[event]
pub struct TokenPayoutSent {
    pub destination: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
}
#[event]
pub struct Swept {
    pub mint: Pubkey,
    pub amount: u64,
}
#[event]
pub struct Paused {}
#[event]
pub struct Unpaused {}
#[event]
pub struct DelegateChanged {
    pub delegate: Pubkey,
}
#[event]
pub struct ConfigScheduled {
    pub eta: i64,
    pub change: ConfigChange,
}
#[event]
pub struct ConfigApplied {}
#[event]
pub struct PendingCanceled {}
#[event]
pub struct AdminProposed {
    pub new_admin: Pubkey,
}
#[event]
pub struct AdminAccepted {
    pub admin: Pubkey,
}
#[event]
pub struct Deposited {
    pub member: Pubkey,
    pub strategy: u8,
    pub amount: u64,
    pub pending: u64,
}
#[event]
pub struct SharesIssued {
    pub member: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub remaining: u64,
}

#[error_code]
pub enum StrategyError {
    #[msg("an undeclared vault token account lost funds during the CPI")]
    UndeclaredOutflow,
    #[msg("strategy is paused")]
    Paused,
    #[msg("target program is not whitelisted")]
    ProgramNotAllowed,
    #[msg("vault PDA must appear as a signer in the CPI")]
    VaultMustSign,
    #[msg("destination is not a whitelisted member")]
    NotWhitelisted,
    #[msg("daily cap exceeded")]
    DailyCapExceeded,
    #[msg("per-transaction cap exceeded")]
    TxCapExceeded,
    #[msg("whitelist too large")]
    WhitelistTooLarge,
    #[msg("caller is not the delegate")]
    NotDelegate,
    #[msg("caller is not the admin")]
    NotAdmin,
    #[msg("caller is not the guardian")]
    NotGuardian,
    #[msg("caller is not the upgrade authority")]
    NotUpgradeAuthority,
    #[msg("could not read program data account")]
    BadProgramData,
    #[msg("unknown strategy index")]
    UnknownStrategy,
    #[msg("borrow exceeds the configured debt ceiling")]
    DebtCeilingExceeded,
    #[msg("collateral flow does not match the declared delta")]
    BadCollateralFlow,
    #[msg("debt flow does not match the declared delta")]
    BadDebtFlow,
    #[msg("stable flow does not match the declared direction")]
    BadStableFlow,
    #[msg("swap input flow does not match the declared amount")]
    BadSwapFlow,
    #[msg("swap output did not land in the vault ATA")]
    BadSwapOut,
    #[msg("position NFT is no longer vault-owned")]
    PositionMoved,
    #[msg("unexpected or wrong account")]
    WrongAccount,
    #[msg("vault token account was hijacked (delegate or close authority set)")]
    AtaHijacked,
    #[msg("mint pair is not allowed")]
    MintPairNotAllowed,
    #[msg("expected accounts are missing")]
    MissingAccounts,
    #[msg("no pending config change")]
    NothingPending,
    #[msg("timelock has not elapsed")]
    TimelockNotReady,
    #[msg("caller is not the proposed admin")]
    NotProposedAdmin,
    #[msg("invalid configuration")]
    BadConfig,
    #[msg("tip exceeds the per-deposit delegate tip cap")]
    TipTooLarge,
    #[msg("tip below the required minimum — deposits fund the keeper")]
    TipTooSmall,
    #[msg("a config change is already scheduled")]
    PendingExists,
    #[msg("payout exceeds the member's recorded deposit")]
    InsufficientDeposit,
    #[msg("min_out below the pair's deviation bound")]
    MinOutTooLow,
    #[msg("vault lamports, owner or data changed during the CPI")]
    VaultDrained,
    #[msg("strategy-critical mints cannot be swept")]
    StrategyAssetNotSweepable,
}

// ---------------------------------------------------------------------------
// unit tests (pure helpers — on-chain paths are covered by tests/poc-local.ts
// and the mainnet fork suite)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(result: Result<()>) -> bool {
        result.is_ok()
    }

    #[test]
    fn declared_delta_must_match_within_tolerance() {
        // exact match
        assert!(ok(assert_declared(
            1000,
            1000,
            10,
            StrategyError::BadDebtFlow
        )));
        // within 1% relative tolerance
        assert!(ok(assert_declared(
            1005,
            1000,
            10,
            StrategyError::BadDebtFlow
        )));
        // outside tolerance — including the declare-zero attack
        assert!(!ok(assert_declared(
            -1_000_000,
            0,
            10,
            StrategyError::BadDebtFlow
        )));
        assert!(!ok(assert_declared(
            0,
            1_000_000,
            10,
            StrategyError::BadDebtFlow
        )));
        assert!(!ok(assert_declared(
            1020,
            1000,
            10,
            StrategyError::BadDebtFlow
        )));
        // small declared amounts use the absolute floor (interest accrual)
        assert!(ok(assert_declared(
            5_000,
            0,
            10_000,
            StrategyError::BadDebtFlow
        )));
        assert!(!ok(assert_declared(
            50_000,
            0,
            10_000,
            StrategyError::BadDebtFlow
        )));
        // negative deltas
        assert!(ok(assert_declared(
            -1000,
            -1000,
            10,
            StrategyError::BadCollateralFlow
        )));
        assert!(!ok(assert_declared(
            -2000,
            -1000,
            10,
            StrategyError::BadCollateralFlow
        )));
    }
}
