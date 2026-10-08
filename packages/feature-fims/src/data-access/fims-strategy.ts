// fims-strategy vault — client-side mirror of the on-chain program.
// Buying a share token (FSOL/FLiP) is not a market swap: the output leg
// is a program `deposit` — the member's collateral lands in the vault in
// the same transaction and the keeper issues shares 1:1 within ~a minute.
// Only the pieces the wallet needs are decoded here; the authoritative
// layout lives in solana-programs/programs/fims-strategy/src/lib.rs.
import {
  AccountRole,
  type Address,
  address,
  type GetAccountInfoApi,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Instruction,
  type Rpc,
} from '@solana/kit'
import { fetchMint, findAssociatedTokenPda } from '@solana-program/token'

export const FIMS_STRATEGY_PROGRAM_ID = address('AtmC4gPAEZ1r4fD698mDaCpGEC5WZN5f4z55zscsdVmS')
const TOKEN_PROGRAM_ID = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const TOKEN_2022_PROGRAM_ID = address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
const ATA_PROGRAM_ID = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
const SYSTEM_PROGRAM_ID = address('11111111111111111111111111111111')

// Member-side delegate tip, capped on-chain at 0.01 SOL. One tip covers
// ~100 keeper transactions (issue_shares + jl_operate + swap + kamino_flow ≈
// ~0.00002 SOL per deposit) — the surplus pays the untipped housekeeping
// (payouts, sweeps, vault ATA rents) so the delegate self-finances forever
// and slowly accumulates.
export const FIMS_STRATEGY_TIP_LAMPORTS = 500_000n

// Extra lamports the deposit leg legitimately spends on top of the swap:
// the delegate tip (0.0005 SOL), the member share ATA rent, the member_deposit
// PDA rent and margin for the collateral ATA the Jupiter setup may create.
export const FIMS_STRATEGY_NATIVE_OVERHEAD_LAMPORTS = 7_000_000n

export interface FimsStrategyConfig {
  collateralMint: Address
  shareMint: Address
}

export interface FimsStrategyState {
  delegate: Address
  paused: boolean
  strategies: FimsStrategyConfig[]
}

const te = new TextEncoder()

class Reader {
  private buf: Uint8Array
  private off: number
  constructor(buf: Uint8Array, off = 0) {
    this.buf = buf
    this.off = off
  }
  u8() {
    const v = this.buf[this.off] ?? 0
    this.off += 1
    return v
  }
  u16() {
    const v = (this.buf[this.off] ?? 0) | ((this.buf[this.off + 1] ?? 0) << 8)
    this.off += 2
    return v
  }
  u32() {
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.off).getUint32(0, true)
    this.off += 4
    return v
  }
  u64() {
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.off).getBigUint64(0, true)
    this.off += 8
    return v
  }
  pubkey() {
    const bytes = this.buf.slice(this.off, this.off + 32)
    this.off += 32
    return bytes
  }
  address() {
    return getAddressDecoder().decode(this.pubkey()) as Address
  }
  vec<T>(item: () => T): T[] {
    const len = this.u32()
    const out: T[] = []
    for (let i = 0; i < len; i++) out.push(item())
    return out
  }
}

// StrategyState: disc(8) | admin | delegate | guardian | treasury | paused u8
// | allowed_programs Vec<Pubkey> | member_whitelist Vec<Pubkey>
// | strategies Vec<StrategyConfig> | allowed_mint_pairs Vec<MintPair>
// Only delegate + strategies matter to the wallet; the rest is walked over.
export function parseStrategyState(data: Uint8Array): FimsStrategyState {
  const r = new Reader(data, 8)
  r.address() // admin
  const delegate = r.address()
  r.address() // guardian
  r.address() // treasury
  const paused = r.u8() !== 0
  r.vec(() => r.pubkey()) // allowed_programs
  r.vec(() => r.pubkey()) // member_whitelist
  // Reads must stay in Rust field order — never sort these keys.
  const strategies = r.vec(() => {
    r.u64() // vault_id
    r.u32() // position_id
    r.pubkey() // vaults_program
    r.pubkey() // position_nft_mint
    const collateralMint = r.address()
    r.pubkey() // borrow_mint
    r.pubkey() // stable_mint
    const shareMint = r.address()
    r.u64() // max_debt
    return { collateralMint, shareMint }
  })
  return { delegate, paused, strategies }
}

export async function fetchStrategyState(rpc: Rpc<GetAccountInfoApi>): Promise<FimsStrategyState | undefined> {
  const res = await rpc.getAccountInfo(await statePda(), { encoding: 'base64' }).send()
  const raw = res.value?.data
  if (!raw) return undefined
  const b64 = typeof raw === 'string' ? raw : raw[0]
  return parseStrategyState(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))
}

export async function statePda(): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: FIMS_STRATEGY_PROGRAM_ID, seeds: [te.encode('state')] }))[0]
}

export async function vaultPda(): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: FIMS_STRATEGY_PROGRAM_ID, seeds: [te.encode('vault')] }))[0]
}

async function memberDepositPda(member: Address, strategyIndex: number): Promise<Address> {
  return (
    await getProgramDerivedAddress({
      programAddress: FIMS_STRATEGY_PROGRAM_ID,
      seeds: [te.encode('deposit'), getAddressEncoder().encode(member), Uint8Array.of(strategyIndex)],
    })
  )[0]
}

async function ataOf(owner: Address, mint: Address, tokenProgram: Address): Promise<Address> {
  return (await findAssociatedTokenPda({ mint, owner, tokenProgram }))[0]
}

// mint → owning token program — legacy SPL or Token-2022 (FLiP): the on-chain
// derivation of every ATA depends on it.
async function mintTokenProgram(rpc: Rpc<GetAccountInfoApi>, mint: Address): Promise<Address> {
  const program = (await fetchMint(rpc, mint)).programAddress
  if (program !== TOKEN_PROGRAM_ID && program !== TOKEN_2022_PROGRAM_ID) {
    throw new Error(`mint ${mint} lives under unexpected program ${program}`)
  }
  return program
}

const WRITABLE_SIGNER = AccountRole.WRITABLE_SIGNER
const READONLY = AccountRole.READONLY
const WRITABLE = AccountRole.WRITABLE

const discCache = new Map<string, Uint8Array>()
async function anchorDisc(name: string): Promise<Uint8Array> {
  const cached = discCache.get(name)
  if (cached) return cached
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(`global:${name}`)))
  const disc = hash.slice(0, 8)
  discCache.set(name, disc)
  return disc
}

/** deposit(strategy_index, amount, tip_lamports) — member moves collateral
 *  to the vault, creates their share ATA, tips the delegate and records the
 *  pending amount the keeper must pay back 1:1 in share tokens. */
export async function buildDepositIx(
  rpc: Rpc<GetAccountInfoApi>,
  {
    amount,
    member,
    state,
    strategyIndex,
    tip = FIMS_STRATEGY_TIP_LAMPORTS,
  }: {
    amount: bigint
    member: Address
    state: FimsStrategyState
    strategyIndex: number
    tip?: bigint
  },
): Promise<Instruction> {
  const strategy = state.strategies[strategyIndex]
  if (!strategy) throw new Error(`unknown strategy index ${strategyIndex}`)
  // Each mint resolves its own token program — a Token-2022 share mint
  // (FLiP) derives every ATA under the 2022 program.
  const collateralTokenProgram = await mintTokenProgram(rpc, strategy.collateralMint)
  const shareTokenProgram = await mintTokenProgram(rpc, strategy.shareMint)
  const data = new Uint8Array(8 + 1 + 8 + 8)
  data.set(await anchorDisc('deposit'), 0)
  data[8] = strategyIndex
  const view = new DataView(data.buffer)
  view.setBigUint64(9, amount, true)
  view.setBigUint64(17, tip, true)
  return {
    accounts: [
      { address: member, role: WRITABLE_SIGNER },
      { address: await statePda(), role: READONLY },
      { address: await ataOf(member, strategy.collateralMint, collateralTokenProgram), role: WRITABLE },
      { address: await vaultPda(), role: WRITABLE },
      { address: await ataOf(await vaultPda(), strategy.collateralMint, collateralTokenProgram), role: WRITABLE },
      { address: state.delegate, role: WRITABLE },
      { address: strategy.shareMint, role: READONLY },
      { address: await ataOf(member, strategy.shareMint, shareTokenProgram), role: WRITABLE },
      { address: await memberDepositPda(member, strategyIndex), role: WRITABLE },
      { address: collateralTokenProgram, role: READONLY },
      { address: shareTokenProgram, role: READONLY },
      { address: SYSTEM_PROGRAM_ID, role: READONLY },
      { address: ATA_PROGRAM_ID, role: READONLY },
    ],
    data,
    programAddress: FIMS_STRATEGY_PROGRAM_ID,
  }
}
