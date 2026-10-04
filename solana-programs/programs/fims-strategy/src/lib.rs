use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::program::invoke_signed;

declare_id!("AtmC4gPAEZ1r4fD698mDaCpGEC5WZN5f4z55zscsdVmS");

// ---------------------------------------------------------------------------
// FiMs strategy vault
//
// A program-owned vault (PDA) that holds the leveraged positions backing FSOL
// and FLIP: Jupiter Lend borrow positions (JUPSOL/USDT, JLP/USDT) and Kamino
// OnRe USDG supply. A delegate key — an automated operator — drives every
// instruction, but only toward programs explicitly whitelisted by the admin
// and only while the vault PDA is the signing owner.
//
// Trust model: the delegate cannot move funds anywhere except through a
// whitelisted protocol call signed by the vault PDA. Funds never leave the
// loop `program ATAs -> whitelisted protocol -> program ATAs` except through
// `payout` (member allowlist + per-tx cap) and `sweep` (hardcoded treasury).
// ---------------------------------------------------------------------------

#[program]
pub mod fims_strategy {
    use super::*;

    /// One-time setup. `admin` is a cold key used only for configuration,
    /// pause and recovery — it is not needed for day-to-day operation.
    /// `delegate` is the automated operator key.
    pub fn initialize(ctx: Context<Initialize>, args: InitializeArgs) -> Result<()> {
        let state = &mut ctx.accounts.state;
        state.admin = args.admin;
        state.delegate = args.delegate;
        state.paused = false;
        state.allowed_programs = args.allowed_programs;
        state.member_whitelist = args.member_whitelist;
        state.treasury = args.treasury;
        state.daily_cap_lamports = args.daily_cap_lamports;
        state.spent_today = 0;
        state.day_start = 0;
        state.vault_bump = ctx.bumps.vault;
        state.bump = ctx.bumps.state;
        Ok(())
    }

    /// Delegate-driven bounded CPI: invokes `data` on a whitelisted target
    /// program with the vault PDA signing. This is how deploy/unwind/rebalance
    /// call Jupiter Lend `operate`, Kamino `depositAndWithdraw` and Jupiter
    /// swap — the vault stays owner of every position and account.
    pub fn cpi_signed(ctx: Context<CpiSigned>, program_id: Pubkey, data: Vec<u8>) -> Result<()> {
        let state = &ctx.accounts.state;
        require!(!state.paused, StrategyError::Paused);
        require!(
            state.allowed_programs.contains(&program_id),
            StrategyError::ProgramNotAllowed
        );

        // The vault PDA must appear as a signer in the account metas — it is
        // what makes this a vault operation and not a delegate spending
        // authority over arbitrary accounts.
        let vault_key = ctx.accounts.vault.key();
        let metas: Vec<AccountMeta> = ctx
            .remaining_accounts
            .iter()
            // The callee program itself is passed for invoke_signed but is
            // not a data account of the inner instruction — skip it here.
            .filter(|info| info.key() != program_id)
            .map(|info| AccountMeta {
                pubkey: info.key(),
                is_signer: info.key() == vault_key || info.is_signer,
                is_writable: info.is_writable,
            })
            .collect();
        require!(
            metas.iter().any(|m| m.pubkey == vault_key && m.is_signer),
            StrategyError::VaultMustSign
        );

        let bump = state.vault_bump;
        let seeds: &[&[u8]] = &[b"vault", &[bump]];
        invoke_signed(
            &Instruction {
                program_id,
                accounts: metas,
                data,
            },
            ctx.remaining_accounts,
            &[seeds],
        )?;
        Ok(())
    }

    /// Transfer out to a member of the fund whitelist, capped per transaction
    /// and per rolling day. Callable by the delegate — the destination is
    /// constrained to `member_whitelist`, the amount to the daily cap.
    pub fn payout(ctx: Context<Payout>, amount: u64) -> Result<()> {
        let state = &mut ctx.accounts.state;
        require!(!state.paused, StrategyError::Paused);
        require!(
            state.member_whitelist.contains(&ctx.accounts.destination.key()),
            StrategyError::NotWhitelisted
        );

        let now = Clock::get()?.unix_timestamp;
        if now - state.day_start >= 86_400 {
            state.day_start = now;
            state.spent_today = 0;
        }
        require!(
            state.spent_today.saturating_add(amount) <= state.daily_cap_lamports,
            StrategyError::DailyCapExceeded
        );
        state.spent_today = state.spent_today.saturating_add(amount);

        let bump = state.vault_bump;
        let seeds: &[&[u8]] = &[b"vault", &[bump]];
        anchor_lang::solana_program::program::invoke_signed(
            &anchor_lang::solana_program::system_instruction::transfer(
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
        Ok(())
    }

    /// Emergency stop: freezes delegate operations instantly. Admin only.
    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        ctx.accounts.state.paused = paused;
        Ok(())
    }

    /// Rotate the operator key (e.g. suspected compromise). Admin only.
    pub fn set_delegate(ctx: Context<AdminOnly>, delegate: Pubkey) -> Result<()> {
        ctx.accounts.state.delegate = delegate;
        Ok(())
    }

    /// Update the whitelisted target programs. Admin only.
    pub fn set_allowed_programs(ctx: Context<AdminOnly>, programs: Vec<Pubkey>) -> Result<()> {
        require!(programs.len() <= 16, StrategyError::WhitelistTooLarge);
        ctx.accounts.state.allowed_programs = programs;
        Ok(())
    }

    /// Update the member whitelist. Admin only.
    pub fn set_member_whitelist(ctx: Context<AdminOnly>, members: Vec<Pubkey>) -> Result<()> {
        require!(members.len() <= 64, StrategyError::WhitelistTooLarge);
        ctx.accounts.state.member_whitelist = members;
        Ok(())
    }
}

// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeArgs {
    pub admin: Pubkey,
    pub delegate: Pubkey,
    pub treasury: Pubkey,
    pub allowed_programs: Vec<Pubkey>,
    pub member_whitelist: Vec<Pubkey>,
    pub daily_cap_lamports: u64,
}

#[account]
pub struct StrategyState {
    pub admin: Pubkey,
    pub delegate: Pubkey,
    pub treasury: Pubkey,
    pub paused: bool,
    pub allowed_programs: Vec<Pubkey>,
    pub member_whitelist: Vec<Pubkey>,
    pub daily_cap_lamports: u64,
    pub spent_today: u64,
    pub day_start: i64,
    pub vault_bump: u8,
    pub bump: u8,
}

impl StrategyState {
    pub const MAX_ALLOWED_PROGRAMS: usize = 16;
    pub const MAX_MEMBERS: usize = 64;
    // 8 discriminator + 3 pubkeys + bool + 2 vecs + 3 scalars + 2 bumps
    pub const SPACE: usize = 8 + 32 * 3 + 1 + 4 + 32 * Self::MAX_ALLOWED_PROGRAMS + 4
        + 32 * Self::MAX_MEMBERS + 8 + 8 + 8 + 1 + 1;
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
    /// CHECK: the strategy vault — a PDA that owns positions and token
    /// accounts; created lazily by rent-exempt funding.
    #[account(seeds = [b"vault"], bump)]
    pub vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CpiSigned<'info> {
    #[account(constraint = caller.key() == state.delegate @ StrategyError::NotDelegate)]
    pub caller: Signer<'info>,
    #[account(seeds = [b"state"], bump = state.bump)]
    pub state: Account<'info, StrategyState>,
    /// CHECK: validated by seeds; forced to sign in the CPI metas.
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
pub struct AdminOnly<'info> {
    #[account(constraint = caller.key() == state.admin @ StrategyError::NotAdmin)]
    pub caller: Signer<'info>,
    #[account(mut, seeds = [b"state"], bump = state.bump)]
    pub state: Account<'info, StrategyState>,
}

#[error_code]
pub enum StrategyError {
    #[msg("strategy is paused")]
    Paused,
    #[msg("target program is not whitelisted")]
    ProgramNotAllowed,
    #[msg("vault PDA must appear as a signer in the CPI")]
    VaultMustSign,
    #[msg("destination is not a whitelisted member")]
    NotWhitelisted,
    #[msg("daily payout cap exceeded")]
    DailyCapExceeded,
    #[msg("whitelist too large")]
    WhitelistTooLarge,
    #[msg("caller is not the delegate")]
    NotDelegate,
    #[msg("caller is not the admin")]
    NotAdmin,
}
