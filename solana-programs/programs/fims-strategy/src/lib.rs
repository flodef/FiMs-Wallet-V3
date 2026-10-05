use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
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
//   * governance: timelocked admin changes, two-step admin transfer,
//     a guardian role that can pause (but not unpause) for fast response
// ---------------------------------------------------------------------------

// SPL Token program and Associated Token Account program — hardcoded so the
// delegate can never point derivations at a look-alike.
pub const TOKEN_PROGRAM_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const ATA_PROGRAM_ID: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const SYSTEM_PROGRAM_ID: Pubkey = pubkey!("11111111111111111111111111111111");

const ADMIN_TIMELOCK_SECS: i64 = 48 * 3600;
const HOUR_SECS: i64 = 3_600;
const MAX_ALLOWED_PROGRAMS: usize = 16;
const MAX_MEMBERS: usize = 64;
const MAX_STRATEGIES: usize = 4;

// SPL Token account layout offsets (165 bytes).
const TA_OWNER: usize = 32;
const TA_AMOUNT: usize = 64;
const TA_DELEGATE_TAG: usize = 72;
const TA_STATE: usize = 116;
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
        require!(ctx.accounts.program_data.key() == expected_pd, StrategyError::BadProgramData);

        let data = ctx.accounts.program_data.try_borrow_data()?;
        // UpgradeableLoaderState::ProgramData = variant u32 3, slot u64,
        // then Option<Pubkey> upgrade authority (u8 tag + 32 bytes).
        require!(data.len() >= 45, StrategyError::BadProgramData);
        require!(u32::from_le_bytes(data[0..4].try_into().unwrap()) == 3, StrategyError::BadProgramData);
        require!(data[12] == 1, StrategyError::BadProgramData);
        let authority = Pubkey::try_from(&data[13..45]).map_err(|_| StrategyError::BadProgramData)?;
        require!(authority == ctx.accounts.payer.key(), StrategyError::NotUpgradeAuthority);
        drop(data);

        validate_whitelists(&args.allowed_programs, &args.member_whitelist)?;
        require!(args.strategies.len() <= MAX_STRATEGIES, StrategyError::BadConfig);
        require!(args.allowed_mint_pairs.len() <= 16, StrategyError::BadConfig);

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
        state.window_start_hour = 0;
        state.pending = None;
        state.proposed_admin = None;
        state.vault_bump = ctx.bumps.vault;
        state.bump = ctx.bumps.state;
        emit!(Initialized { admin: args.admin, delegate: args.delegate });
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
        require!(col_delta != i64::MIN && debt_delta != i64::MIN, StrategyError::BadConfig);

        let vault_key = ctx.accounts.vault.key();
        let col_ata = find_ata(ctx.remaining_accounts, vault_key, strategy.collateral_mint)?;
        let debt_ata = find_ata(ctx.remaining_accounts, vault_key, strategy.borrow_mint)?;
        let nft_ata = find_ata(ctx.remaining_accounts, vault_key, strategy.position_nft_mint)?;
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

        cpi_whitelisted(state, ctx.remaining_accounts, data, vault_key, state.vault_bump)?;

        // Position accounting must match the declared deltas — this is what
        // stops an undeclared withdrawal or borrow.
        let supply_delta = position_field(&position, POSITION_SUPPLY_OFF)? as i128 - supply_before as i128;
        let dust_delta = position_field(&position, POSITION_DEBT_OFF)? as i128 - dust_before as i128;
        // Supply tolerance is tight (10 base units); debt tolerance is wider
        // (10k base units ≈ cent-level) because interest accrues per second.
        assert_declared(supply_delta, col_delta, 10, StrategyError::BadCollateralFlow)?;
        assert_declared(dust_delta, debt_delta, 10_000, StrategyError::BadDebtFlow)?;

        // Token flows must land in / leave from the vault's own ATAs:
        //   col_delta  > 0 deposit  -> vault collateral leaves by >= delta
        //   col_delta  < 0 withdraw -> vault collateral arrives by >= |delta| (fees tolerated)
        //   debt_delta > 0 borrow   -> vault borrow-mint arrives by >= delta
        //   debt_delta < 0 repay    -> vault borrow-mint leaves by >= |delta|
        assert_delta(&col_ata, col_before, -col_delta, StrategyError::BadCollateralFlow)?;
        assert_delta(&debt_ata, debt_before, debt_delta, StrategyError::BadDebtFlow)?;

        // Total debt is bound by the position's own accounting — the ceiling
        // is real, not a per-operation guess.
        let dust_after = position_field(&position, POSITION_DEBT_OFF)?;
        require!(dust_after <= strategy.max_debt, StrategyError::DebtCeilingExceeded);

        // The position NFT is still vault property and the ATAs are healthy.
        assert_token_amount(&nft_ata, 1, StrategyError::PositionMoved)?;
        assert_healthy_ata(&col_ata, vault_key)?;
        assert_healthy_ata(&debt_ata, vault_key)?;
        assert_healthy_ata(&nft_ata, vault_key)?;
        assert_undeclared_atas_intact(ctx.remaining_accounts, vault_key, &others_before)?;
        emit!(JlOperate { strategy: strategy_index, col_delta, debt_delta });
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
        let strategy = state
            .strategies
            .get(strategy_index as usize)
            .ok_or(StrategyError::UnknownStrategy)?;
        let stable_mint = strategy.stable_mint;
        let vault_key = ctx.accounts.vault.key();

        let ata = find_ata(ctx.remaining_accounts, vault_key, stable_mint)?;
        let before = token_amount(&ata)?;
        let others_before = snapshot_undeclared_atas(ctx.remaining_accounts, vault_key, &[ata.key()]);

        cpi_whitelisted(state, ctx.remaining_accounts, data, vault_key, state.vault_bump)?;

        let expected = match direction {
            FlowDirection::Supply => -(amount as i64),
            FlowDirection::Withdraw => amount as i64,
        };
        assert_delta(&ata, before, expected, StrategyError::BadStableFlow)?;
        assert_healthy_ata(&ata, vault_key)?;
        assert_undeclared_atas_intact(ctx.remaining_accounts, vault_key, &others_before)?;
        emit!(KaminoFlow { strategy: strategy_index, direction, amount });
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
        let state = &ctx.accounts.state;
        require!(!state.paused, StrategyError::Paused);
        require!(
            state
                .allowed_mint_pairs
                .iter()
                .any(|p| p.from == in_mint && p.to == out_mint),
            StrategyError::MintPairNotAllowed
        );
        require!(amount > 0 && min_out > 0, StrategyError::BadConfig);
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

        cpi_whitelisted(state, ctx.remaining_accounts, data, vault_key, state.vault_bump)?;

        // Input must leave by exactly `amount` — a swap whose output goes to
        // an external account leaves the vault ATA short and fails; a swap
        // that pulls more than declared fails too.
        assert_delta_exact(&in_ata, in_before, -(amount as i64), StrategyError::BadSwapFlow)?;
        assert_delta(&out_ata, out_before, min_out as i64, StrategyError::BadSwapOut)?;
        assert_healthy_ata(&in_ata, vault_key)?;
        assert_healthy_ata(&out_ata, vault_key)?;
        assert_undeclared_atas_intact(ctx.remaining_accounts, vault_key, &others_before)?;
        emit!(Swap { in_mint, out_mint, amount, min_out });
        Ok(())
    }

    // -- exits ----------------------------------------------------------------

    /// SOL transfer to a whitelisted member, capped per transaction and over
    /// a rolling 24-hour window (hourly buckets — no midnight double-spend).
    pub fn payout(ctx: Context<Payout>, amount: u64) -> Result<()> {
        let state = &mut ctx.accounts.state;
        require!(!state.paused, StrategyError::Paused);
        require!(
            state.member_whitelist.contains(&ctx.accounts.destination.key()),
            StrategyError::NotWhitelisted
        );
        spend_allowance(state, amount)?;

        let seeds: &[&[u8]] = &[b"vault", &[state.vault_bump]];
        invoke_signed(
            &system_instruction::transfer(&ctx.accounts.vault.key(), &ctx.accounts.destination.key(), amount),
            &[
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.destination.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[seeds],
        )?;
        emit!(PayoutSent { destination: ctx.accounts.destination.key(), amount });
        Ok(())
    }

    /// SPL payout: destination must be the ATA of a whitelisted member for
    /// that mint, capped by the same rolling window (token base units).
    pub fn payout_token(ctx: Context<PayoutToken>, mint: Pubkey, amount: u64) -> Result<()> {
        let state = &mut ctx.accounts.state;
        require!(!state.paused, StrategyError::Paused);
        let vault_key = ctx.accounts.vault.key();
        let expected_source = ata_address(vault_key, mint);
        require!(ctx.accounts.source.key() == expected_source, StrategyError::WrongAccount);
        require!(
            is_member_ata(state, &ctx.accounts.destination.key(), mint),
            StrategyError::NotWhitelisted
        );
        spend_token_allowance(state, amount)?;

        let seeds: &[&[u8]] = &[b"vault", &[state.vault_bump]];
        invoke_signed(
            &spl_transfer_ix(ctx.accounts.source.key(), ctx.accounts.destination.key(), vault_key, amount),
            &[
                ctx.accounts.source.to_account_info(),
                ctx.accounts.destination.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
            ],
            &[seeds],
        )?;
        emit!(TokenPayoutSent { destination: ctx.accounts.destination.key(), mint, amount });
        Ok(())
    }

    /// Move yield to the treasury — the only delegate-callable exit besides
    /// capped member payouts. Destination is fixed in state, timelocked to
    /// change.
    pub fn sweep(ctx: Context<Sweep>, mint: Pubkey, amount: u64) -> Result<()> {
        let state = &ctx.accounts.state;
        require!(!state.paused, StrategyError::Paused);
        let vault_key = ctx.accounts.vault.key();
        let treasury = state.treasury;
        let expected_source = ata_address(vault_key, mint);
        let expected_dest = ata_address(treasury, mint);
        require!(ctx.accounts.source.key() == expected_source, StrategyError::WrongAccount);
        require!(ctx.accounts.destination.key() == expected_dest, StrategyError::WrongAccount);

        let seeds: &[&[u8]] = &[b"vault", &[state.vault_bump]];
        invoke_signed(
            &spl_transfer_ix(ctx.accounts.source.key(), ctx.accounts.destination.key(), vault_key, amount),
            &[
                ctx.accounts.source.to_account_info(),
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

    /// Delegate rotation is immediate on purpose: it is the incident-response
    /// path when the operator key is suspected compromised.
    pub fn set_delegate(ctx: Context<AdminOnly>, delegate: Pubkey) -> Result<()> {
        ctx.accounts.state.delegate = delegate;
        emit!(DelegateChanged { delegate });
        Ok(())
    }

    /// All dangerous configuration changes go through a 48h timelock so
    /// members have time to exit before new rules apply.
    pub fn schedule_config(ctx: Context<AdminOnly>, change: ConfigChange) -> Result<()> {
        match &change {
            ConfigChange::AllowedPrograms { programs } => validate_whitelists(programs, &[])?,
            ConfigChange::MemberWhitelist { members } => validate_whitelists(&[], members)?,
            ConfigChange::Strategies { strategies } => {
                require!(strategies.len() <= MAX_STRATEGIES, StrategyError::BadConfig);
            }
            _ => {}
        }
        let state = &mut ctx.accounts.state;
        state.pending = Some(PendingConfig {
            eta: Clock::get()?.unix_timestamp.saturating_add(ADMIN_TIMELOCK_SECS),
            change,
        });
        emit!(ConfigScheduled {});
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
            ConfigChange::Caps { daily_lamports, tx_lamports, daily_token } => {
                state.daily_cap_lamports = daily_lamports;
                state.tx_cap_lamports = tx_lamports;
                state.daily_token_cap = daily_token;
            }
            ConfigChange::Strategies { strategies } => state.strategies = strategies,
            ConfigChange::MintPairs { pairs } => state.allowed_mint_pairs = pairs,
        }
        emit!(ConfigApplied {});
        Ok(())
    }

    /// Two-step admin handover: losing the key is recoverable, grabbing it
    /// without the accept signature is not.
    pub fn propose_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        ctx.accounts.state.proposed_admin = Some(new_admin);
        emit!(AdminProposed { new_admin });
        Ok(())
    }

    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        let state = &mut ctx.accounts.state;
        let proposed = state.proposed_admin.ok_or(StrategyError::NothingPending)?;
        require!(proposed == ctx.accounts.caller.key(), StrategyError::NotProposedAdmin);
        state.admin = proposed;
        state.proposed_admin = None;
        emit!(AdminAccepted { admin: proposed });
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

fn validate_whitelists(programs: &[Pubkey], members: &[Pubkey]) -> Result<()> {
    require!(programs.len() <= MAX_ALLOWED_PROGRAMS, StrategyError::WhitelistTooLarge);
    require!(members.len() <= MAX_MEMBERS, StrategyError::WhitelistTooLarge);
    // Never allow the strategy program itself as a CPI target.
    require!(!programs.contains(&crate::ID), StrategyError::ProgramNotAllowed);
    // Generic transfer/account programs are never valid CPI targets: they can
    // move vault assets to arbitrary accounts with no protocol-side witness
    // for the post-conditions to check against.
    for banned in [TOKEN_PROGRAM_ID, ATA_PROGRAM_ID, SYSTEM_PROGRAM_ID] {
        require!(!programs.contains(&banned), StrategyError::ProgramNotAllowed);
    }
    require!(!members.contains(&Pubkey::default()), StrategyError::BadConfig);
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
    let (program_info, data_accounts) = remaining.split_last().ok_or(StrategyError::MissingAccounts)?;
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
    invoke_signed(
        &Instruction { program_id, accounts: metas, data },
        remaining,
        &[&[b"vault", &[vault_bump]]],
    )?;
    Ok(())
}

/// ATA address of `owner` for `mint` under the canonical SPL Token program.
fn ata_address(owner: Pubkey, mint: Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[owner.as_ref(), TOKEN_PROGRAM_ID.as_ref(), mint.as_ref()],
        &ATA_PROGRAM_ID,
    )
    .0
}

/// Find the vault's ATA for `mint` inside the remaining accounts and return
/// its raw data — the delegate proves the account belongs to the vault by
/// construction, not by index.
fn find_ata<'info>(remaining: &'info [AccountInfo<'info>], vault: Pubkey, mint: Pubkey) -> Result<AccountInfo<'info>> {
    let expected = ata_address(vault, mint);
    remaining
        .iter()
        .find(|info| info.key() == expected)
        .cloned()
        .ok_or_else(|| StrategyError::MissingAccounts.into())
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
    require!(position.owner == &strategy.vaults_program, StrategyError::WrongAccount);
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
    Ok(u64::from_le_bytes(data[offset..offset + 8].try_into().unwrap()))
}

/// SPL token balance if `info` is a token account owned by `vault`, else None.
fn vault_ata_amount(info: &AccountInfo, vault: &Pubkey) -> Option<u64> {
    if info.owner != &TOKEN_PROGRAM_ID {
        return None
    }
    let data = info.try_borrow_data().ok()?;
    if data.len() < 165 {
        return None
    }
    if Pubkey::try_from(&data[TA_OWNER..TA_OWNER + 32]).ok()? != *vault {
        return None
    }
    Some(u64::from_le_bytes(data[TA_AMOUNT..TA_AMOUNT + 8].try_into().ok()?))
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
        require!(token_amount(info)? >= *amt, StrategyError::UndeclaredOutflow);
        assert_healthy_ata(info, vault)?;
    }
    Ok(())
}

/// Declared delta must match the actual on-chain delta within tolerance —
/// a delegate cannot hide an operation by declaring zero. `abs_floor` covers
/// rounding and, on the debt side, interest accrued between build and land.
fn assert_declared(actual: i128, declared: i64, abs_floor: u64, err: StrategyError) -> Result<()> {
    let declared = declared as i128;
    let tolerance = (declared.unsigned_abs() * DELTA_TOLERANCE_NUM as u128 / DELTA_TOLERANCE_DEN as u128)
        .max(abs_floor as u128) as i128;
    if (actual - declared).abs() > tolerance {
        return Err(err.into());
    }
    Ok(())
}

/// Raw balance of an SPL token account. Fails if the account is not a real
/// token account (wrong owner program or too small).
fn token_amount(ata: &AccountInfo) -> Result<u64> {
    require!(ata.owner == &TOKEN_PROGRAM_ID, StrategyError::WrongAccount);
    let data = ata.try_borrow_data()?;
    require!(data.len() >= 165, StrategyError::WrongAccount);
    Ok(u64::from_le_bytes(data[TA_AMOUNT..TA_AMOUNT + 8].try_into().unwrap()))
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
    let ok = if expected >= 0 { delta >= expected as i128 } else { delta <= expected as i128 };
    if !ok {
        return Err(err.into());
    }
    Ok(())
}

/// Strict version: the delta must equal `expected` exactly.
fn assert_delta_exact(ata: &AccountInfo, before: u64, expected: i64, err: StrategyError) -> Result<()> {
    let delta = token_amount(ata)? as i128 - before as i128;
    if delta != expected as i128 {
        return Err(err.into());
    }
    Ok(())
}

/// A healthy vault ATA: owned by the vault PDA, no delegate, no close
/// authority — checked after every CPI so nothing can hijack the account.
fn assert_healthy_ata(ata: &AccountInfo, vault: Pubkey) -> Result<()> {
    let data = ata.try_borrow_data()?;
    require!(data.len() >= 165, StrategyError::WrongAccount);
    require!(Pubkey::try_from(&data[TA_OWNER..TA_OWNER + 32]).map_err(|_| StrategyError::WrongAccount)? == vault, StrategyError::WrongAccount);
    require!(data[TA_STATE] == TA_INITIALIZED, StrategyError::WrongAccount);
    require!(u32::from_le_bytes(data[TA_DELEGATE_TAG..TA_DELEGATE_TAG + 4].try_into().unwrap()) == 0, StrategyError::AtaHijacked);
    require!(u32::from_le_bytes(data[TA_CLOSE_AUTH_TAG..TA_CLOSE_AUTH_TAG + 4].try_into().unwrap()) == 0, StrategyError::AtaHijacked);
    Ok(())
}

/// Whether `destination` is the ATA of a whitelisted member for `mint`.
fn is_member_ata(state: &StrategyState, destination: &Pubkey, mint: Pubkey) -> bool {
    state
        .member_whitelist
        .iter()
        .any(|member| ata_address(*member, mint) == *destination)
}

fn spl_transfer_ix(source: Pubkey, destination: Pubkey, authority: Pubkey, amount: u64) -> Instruction {
    let mut data = Vec::with_capacity(9);
    data.push(3u8); // Transfer
    data.extend_from_slice(&amount.to_le_bytes());
    Instruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(source, false),
            AccountMeta::new(destination, false),
            AccountMeta::new_readonly(authority, true),
        ],
        data,
    }
}

/// Rolling-window allowance for SOL payouts (hourly buckets).
fn spend_allowance(state: &mut StrategyState, amount: u64) -> Result<()> {
    let tx_cap = state.tx_cap_lamports;
    let window_cap = state.daily_cap_lamports;
    spend_window(state, amount, tx_cap, window_cap, true)
}

fn spend_token_allowance(state: &mut StrategyState, amount: u64) -> Result<()> {
    let cap = state.daily_token_cap;
    spend_window(state, amount, cap, cap, false)
}

fn spend_window(
    state: &mut StrategyState,
    amount: u64,
    tx_cap: u64,
    window_cap: u64,
    sol_window: bool,
) -> Result<()> {
    require!(amount <= tx_cap, StrategyError::TxCapExceeded);
    let now = Clock::get()?.unix_timestamp;
    let hour = now.div_euclid(HOUR_SECS);
    // Clear buckets older than 24h.
    if state.window_start_hour == 0 {
        state.window_start_hour = hour;
    }
    let elapsed = hour.saturating_sub(state.window_start_hour);
    if elapsed > 0 {
        let to_clear = elapsed.min(24) as usize;
        for i in 0..to_clear {
            let idx = ((state.window_start_hour + i as i64) % 24) as usize;
            state.spent_sol_hourly[idx] = 0;
            state.spent_token_hourly[idx] = 0;
        }
        state.window_start_hour = hour;
    }
    let buckets = if sol_window { &mut state.spent_sol_hourly } else { &mut state.spent_token_hourly };
    let spent: u64 = buckets.iter().fold(0u64, |a, b| a.saturating_add(*b));
    require!(spent.saturating_add(amount) <= window_cap, StrategyError::DailyCapExceeded);
    buckets[(hour % 24) as usize] = buckets[(hour % 24) as usize].saturating_add(amount);
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
    /// Hard ceiling on total position debt (post-op dustDebtAmount must
    /// stay under it), in borrow-mint base units.
    pub max_debt: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct MintPair {
    pub from: Pubkey,
    pub to: Pubkey,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum FlowDirection {
    Supply,
    Withdraw,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub enum ConfigChange {
    AllowedPrograms { programs: Vec<Pubkey> },
    MemberWhitelist { members: Vec<Pubkey> },
    Treasury { treasury: Pubkey },
    Caps { daily_lamports: u64, tx_lamports: u64, daily_token: u64 },
    Strategies { strategies: Vec<StrategyConfig> },
    MintPairs { pairs: Vec<MintPair> },
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
        + 4 + (8 + 4 + 32 * 4 + 32 + 32 + 8) * MAX_STRATEGIES
        + 4 + 64 * 16
        + 8 + 8 + 8
        + 8 * 48
        + 8
        + 1 + 8 + 4 + 4 + 32 * MAX_ALLOWED_PROGRAMS // pending worst-case
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
    pub state: Account<'info, StrategyState>,
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
    #[account(seeds = [b"state"], bump = state.bump)]
    pub state: Account<'info, StrategyState>,
    /// CHECK: validated by seeds; becomes the forced signer in the CPI.
    #[account(seeds = [b"vault"], bump = state.vault_bump)]
    pub vault: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Payout<'info> {
    #[account(constraint = caller.key() == state.delegate @ StrategyError::NotDelegate)]
    pub caller: Signer<'info>,
    #[account(mut, seeds = [b"state"], bump = state.bump)]
    pub state: Account<'info, StrategyState>,
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
    pub state: Account<'info, StrategyState>,
    /// CHECK: validated by seeds.
    #[account(mut, seeds = [b"vault"], bump = state.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: must be the vault ATA for `mint` — enforced in the handler.
    #[account(mut)]
    pub source: UncheckedAccount<'info>,
    /// CHECK: must be a member's ATA for `mint` — enforced in the handler.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    /// CHECK: SPL Token program — pinned to the canonical id.
    #[account(address = TOKEN_PROGRAM_ID)]
    pub token_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Sweep<'info> {
    #[account(constraint = caller.key() == state.delegate @ StrategyError::NotDelegate)]
    pub caller: Signer<'info>,
    #[account(seeds = [b"state"], bump = state.bump)]
    pub state: Account<'info, StrategyState>,
    /// CHECK: validated by seeds.
    #[account(mut, seeds = [b"vault"], bump = state.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: must be the vault ATA for `mint`.
    #[account(mut)]
    pub source: UncheckedAccount<'info>,
    /// CHECK: must be the treasury ATA for `mint`.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    /// CHECK: SPL Token program — pinned to the canonical id.
    #[account(address = TOKEN_PROGRAM_ID)]
    pub token_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct GuardianOnly<'info> {
    #[account(constraint = caller.key() == state.guardian @ StrategyError::NotGuardian)]
    pub caller: Signer<'info>,
    #[account(mut, seeds = [b"state"], bump = state.bump)]
    pub state: Account<'info, StrategyState>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(constraint = caller.key() == state.admin @ StrategyError::NotAdmin)]
    pub caller: Signer<'info>,
    #[account(mut, seeds = [b"state"], bump = state.bump)]
    pub state: Account<'info, StrategyState>,
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub caller: Signer<'info>,
    #[account(mut, seeds = [b"state"], bump = state.bump)]
    pub state: Account<'info, StrategyState>,
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
pub struct ConfigScheduled {}
#[event]
pub struct ConfigApplied {}
#[event]
pub struct AdminProposed {
    pub new_admin: Pubkey,
}
#[event]
pub struct AdminAccepted {
    pub admin: Pubkey,
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
        assert!(ok(assert_declared(1000, 1000, 10, StrategyError::BadDebtFlow)));
        // within 1% relative tolerance
        assert!(ok(assert_declared(1005, 1000, 10, StrategyError::BadDebtFlow)));
        // outside tolerance — including the declare-zero attack
        assert!(!ok(assert_declared(-1_000_000, 0, 10, StrategyError::BadDebtFlow)));
        assert!(!ok(assert_declared(0, 1_000_000, 10, StrategyError::BadDebtFlow)));
        assert!(!ok(assert_declared(1020, 1000, 10, StrategyError::BadDebtFlow)));
        // small declared amounts use the absolute floor (interest accrual)
        assert!(ok(assert_declared(5_000, 0, 10_000, StrategyError::BadDebtFlow)));
        assert!(!ok(assert_declared(50_000, 0, 10_000, StrategyError::BadDebtFlow)));
        // negative deltas
        assert!(ok(assert_declared(-1000, -1000, 10, StrategyError::BadCollateralFlow)));
        assert!(!ok(assert_declared(-2000, -1000, 10, StrategyError::BadCollateralFlow)));
    }
}
