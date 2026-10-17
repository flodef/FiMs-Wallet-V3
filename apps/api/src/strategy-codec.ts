// cspell:ignore ABCDEFGHJKLMNPQRSTUVWXY Zabcdefghijkmnopqrstuvwxyz
// On-chain wire format for the fims-strategy program: base58, Anchor
// discriminators, borsh account parsing, PDA derivations and raw byte
// builders. Pure functions — the keeper logic lives in strategy-delegate.ts,
// the layouts mirror solana-programs/programs/fims-strategy/src/lib.rs.
import { getBase58Encoder } from '@solana/codecs-strings'
import { type Address, address, getProgramDerivedAddress } from '@solana/kit'
import { findAssociatedTokenPda } from '@solana-program/token'

export const STRATEGY_PROGRAM_ID = address('AtmC4gPAEZ1r4fD698mDaCpGEC5WZN5f4z55zscsdVmS')

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

export function encodeBase58(bytes: Uint8Array): string {
  const digits = [0]
  for (const byte of bytes) {
    let carry = byte
    for (let i = 0; i < digits.length; i++) {
      carry += (digits[i] ?? 0) << 8
      digits[i] = carry % 58
      carry = Math.floor(carry / 58)
    }
    while (carry) {
      digits.push(carry % 58)
      carry = Math.floor(carry / 58)
    }
  }
  let out = ''
  for (const byte of bytes) {
    if (byte !== 0) break
    out += '1'
  }
  return (
    out +
    digits
      .reverse()
      .map((d) => B58[d])
      .join('')
  )
}

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
  vec<T>(item: () => T): T[] {
    const len = this.u32()
    const out: T[] = []
    for (let i = 0; i < len; i++) out.push(item())
    return out
  }
}

const discCache = new Map<string, Uint8Array>()
export async function anchorDisc(name: string): Promise<Uint8Array> {
  const cached = discCache.get(name)
  if (cached) return cached
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`global:${name}`)))
  const disc = hash.slice(0, 8)
  discCache.set(name, disc)
  return disc
}

let memberDepositDiscPromise: Promise<Uint8Array> | undefined
export function memberDepositDisc(): Promise<Uint8Array> {
  memberDepositDiscPromise ??= crypto.subtle
    .digest('SHA-256', new TextEncoder().encode('account:MemberDeposit'))
    .then((h) => new Uint8Array(h).slice(0, 8))
  return memberDepositDiscPromise
}

// ---------------------------------------------------------------------------
// account layouts — mirrors solana-programs/programs/fims-strategy/src/lib.rs
// ---------------------------------------------------------------------------

export interface StrategyConfigParsed {
  vaultId: bigint
  positionId: number
  vaultsProgram: Address
  positionNftMint: Address
  collateralMint: Address
  borrowMint: Address
  stableMint: Address
  shareMint: Address
  maxDebt: bigint
}

export interface MintPairParsed {
  from: Address
  to: Address
  maxDeviationBps: number
  dailyCap: bigint
}

export interface StrategyStateParsed {
  admin: Address
  delegate: Address
  treasury: Address
  paused: boolean
  memberWhitelist: Address[]
  strategies: StrategyConfigParsed[]
  mintPairs: MintPairParsed[]
}

export function parseStrategyState(data: Uint8Array): StrategyStateParsed {
  const r = new Reader(data, 8) // anchor discriminator
  const admin = encodeBase58(r.pubkey()) as Address
  const delegate = encodeBase58(r.pubkey()) as Address
  r.pubkey() // guardian
  const treasury = encodeBase58(r.pubkey()) as Address
  const paused = r.u8() !== 0
  r.vec(() => r.pubkey()) // allowed_programs
  const memberWhitelist = r.vec(() => encodeBase58(r.pubkey()) as Address)
  // NB: reads must stay in Rust field order — never sort these keys.
  const strategies = r.vec(() => {
    const vaultId = r.u64()
    const positionId = r.u32()
    const vaultsProgram = encodeBase58(r.pubkey()) as Address
    const positionNftMint = encodeBase58(r.pubkey()) as Address
    const collateralMint = encodeBase58(r.pubkey()) as Address
    const borrowMint = encodeBase58(r.pubkey()) as Address
    const stableMint = encodeBase58(r.pubkey()) as Address
    const shareMint = encodeBase58(r.pubkey()) as Address
    const maxDebt = r.u64()
    return {
      borrowMint,
      collateralMint,
      maxDebt,
      positionId,
      positionNftMint,
      shareMint,
      stableMint,
      vaultId,
      vaultsProgram,
    }
  })
  const mintPairs = r.vec(() => {
    const from = encodeBase58(r.pubkey()) as Address
    const to = encodeBase58(r.pubkey()) as Address
    const maxDeviationBps = r.u16()
    const dailyCap = r.u64()
    return { dailyCap, from, maxDeviationBps, to }
  })
  return { admin, delegate, memberWhitelist, mintPairs, paused, strategies, treasury }
}

export interface MemberDepositParsed {
  member: Address
  strategyIndex: number
  pending: bigint
}

// disc(8) | member(32) | strategy u8 | pending u64 | bump u8
export function parseMemberDeposit(data: Uint8Array): MemberDepositParsed {
  return {
    member: encodeBase58(data.slice(8, 40)) as Address,
    pending: new DataView(data.buffer, data.byteOffset + 41).getBigUint64(0, true),
    strategyIndex: data[40] ?? 0,
  }
}

// ---------------------------------------------------------------------------
// PDAs + instruction encoders (Anchor/borsh, same wire format as poc-local.ts)
// ---------------------------------------------------------------------------

export const te = new TextEncoder()

// Mirrors the on-chain find_position layout — if the Fluid vaults program is
// upgraded and the position account shape drifts, status reports unhealthy
// BEFORE the delegate burns retries on instructions that would now revert.
export const POSITION_LEN = 71
export const POSITION_MINT_OFF = 14

export async function positionPda(strategy: StrategyConfigParsed): Promise<Address> {
  const vaultId = new Uint8Array(2)
  // vault_id is u64 on-chain truncated to u16 in the PDA seeds.
  new DataView(vaultId.buffer).setUint16(0, Number(strategy.vaultId) & 0xffff, true)
  const positionId = new Uint8Array(4)
  new DataView(positionId.buffer).setUint32(0, strategy.positionId, true)
  return (
    await getProgramDerivedAddress({
      programAddress: strategy.vaultsProgram,
      seeds: [te.encode('position'), vaultId, positionId],
    })
  )[0]
}

export async function statePda(): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: STRATEGY_PROGRAM_ID, seeds: [te.encode('state')] }))[0]
}

export async function vaultPda(): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: STRATEGY_PROGRAM_ID, seeds: [te.encode('vault')] }))[0]
}

export async function memberDepositPda(member: Address, strategyIndex: number): Promise<Address> {
  return (
    await getProgramDerivedAddress({
      programAddress: STRATEGY_PROGRAM_ID,
      seeds: [te.encode('deposit'), new Uint8Array(addressToBytes(member)), Uint8Array.of(strategyIndex)],
    })
  )[0]
}

export function addressToBytes(addr: Address): Uint8Array {
  return Uint8Array.from(getBase58Encoder().encode(addr))
}

export async function vaultAta(mint: Address, tokenProgram: Address): Promise<Address> {
  return (await findAssociatedTokenPda({ mint, owner: await vaultPda(), tokenProgram }))[0]
}

export async function memberAta(member: Address, mint: Address, tokenProgram: Address): Promise<Address> {
  return (await findAssociatedTokenPda({ mint, owner: member, tokenProgram }))[0]
}

export const u8 = (n: number) => Uint8Array.of(n)
export const u64 = (n: bigint) => new Uint8Array(new BigUint64Array([n]).buffer)
export const i64 = (n: bigint) => new Uint8Array(new BigInt64Array([n]).buffer)
export const u32 = (n: number) => new Uint8Array(new Uint32Array([n]).buffer)
export const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
export const borshBytes = (data: Uint8Array) => concat([u32(data.length), data])
export const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

export const SIGNER = 3 // AccountRole.WRITABLE_SIGNER
export const RO = 0 // AccountRole.READONLY
export const RW = 1 // AccountRole.WRITABLE
