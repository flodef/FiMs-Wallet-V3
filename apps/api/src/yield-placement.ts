// Yield placement for custodial backing — optional per product.
//
//   fims-eur → Jupiter Earn (EURC → jlEURC) via the Lend instructions API
//   fims-usd → Kamino OnReMarket (USDG) via the KTX instructions API
//
// Both providers return raw instructions that get composed into the
// custodial mint/burn transaction, so conversion stays atomic with the
// mint (Option B: the member's transfer and the placement are separate
// transactions, but placement + mint are one). A product without yield
// configured skips placement entirely — backing just sits in custody.
//
// Kamino needs the OnReMarket market + reserve addresses as env config;
// Jupiter Earn only needs the backing mint (already in product config).
import { AccountRole, type Address, address, type Instruction } from '@solana/kit'
import { findAssociatedTokenPda } from '@solana-program/token'
import type { FimsWrappedProduct, WrappedProductConfig } from './custodial.js'

const JUPITER_EARN_API = () => process.env['JUPITER_EARN_API'] ?? 'https://api.jup.ag/lend/v1/earn'
const KAMINO_KTX_API = () => process.env['KAMINO_KTX_API'] ?? 'https://api.kamino.finance/ktx'

export type YieldAction = 'deposit' | 'withdraw'

type RawInstruction = {
  programId: string
  accounts: { isSigner: boolean; isWritable: boolean; pubkey: string }[]
  data: string
}

const PRODUCT_YIELD: Record<FimsWrappedProduct, { typeEnv: string }> = {
  'fims-eur': { typeEnv: 'FIMS_EURO_YIELD' },
  'fims-usd': { typeEnv: 'FIMS_USD_YIELD' },
}

type YieldType = 'jupiter-earn' | 'kamino'

function yieldType(product: FimsWrappedProduct): YieldType | null {
  const value = process.env[PRODUCT_YIELD[product].typeEnv]
  return value === 'jupiter-earn' || value === 'kamino' ? value : null
}

// ---------------------------------------------------------------------------
// Provider-instruction allowlist.
//
// Jupiter / Kamino answer an HTTP request with raw instructions that the
// custodial hot key then signs. A compromised or misconfigured provider could
// return SetAuthority (seize the mint), Approve/CloseAccount (delegate or
// drain ATAs) or a System transfer (steal SOL) — so every instruction is
// checked before it ever reaches the signer:
//
//   1. programId must be allowlisted: the two token programs, ATA, compute
//      budget, and the venue's own lending program. The System program is
//      NEVER allowed — custody must not move lamports through provider ixs.
//   2. No instruction may request a signature from anything but the custody
//      wallet itself.
//   3. Token-program instructions are limited to TransferChecked (12), and
//      the source must be the custody ATA of the very mint in the
//      instruction — the provider can only move custody's own tokens of the
//      mint it declares, never mint, burn, approve, or touch other accounts.
//
// The simulation guard in custodial.ts then re-checks the final balance
// deltas of the whole composed transaction.
// ---------------------------------------------------------------------------
const SYSTEM_PROGRAM = '11111111111111111111111111111111'
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111'

const VENUE_PROGRAM: Record<YieldType, string> = {
  'jupiter-earn': 'jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9',
  kamino: 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD',
}

const TRANSFER_CHECKED_DISCRIMINATOR = 12

function allowedPrograms(type: YieldType): Set<string> {
  const extra = (process.env['FIMS_YIELD_EXTRA_PROGRAMS'] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  return new Set([
    ATA_PROGRAM,
    COMPUTE_BUDGET_PROGRAM,
    TOKEN_PROGRAM,
    TOKEN_2022_PROGRAM,
    VENUE_PROGRAM[type],
    ...extra,
  ])
}

function isSignerRole(role: AccountRole): boolean {
  return role === AccountRole.WRITABLE_SIGNER || role === AccountRole.READONLY_SIGNER
}

export async function assertSafeYieldInstructions(
  type: YieldType,
  instructions: Instruction[],
  wallet: Address,
): Promise<void> {
  const allowed = allowedPrograms(type)
  for (const [index, ix] of instructions.entries()) {
    const program = `${ix.programAddress}`
    if (program === SYSTEM_PROGRAM || !allowed.has(program)) {
      throw new Error(`yield instruction ${index} targets non-allowlisted program ${program}`)
    }
    for (const account of ix.accounts ?? []) {
      if (isSignerRole(account.role) && account.address !== wallet) {
        throw new Error(`yield instruction ${index} demands an extra signer ${account.address}`)
      }
    }
    if (program === TOKEN_PROGRAM || program === TOKEN_2022_PROGRAM) {
      const discriminator = ix.data?.[0]
      if (discriminator !== TRANSFER_CHECKED_DISCRIMINATOR) {
        throw new Error(`yield instruction ${index} uses forbidden token instruction ${discriminator ?? 'none'}`)
      }
      // TransferChecked metas: [source, mint, destination, authority, ...]
      const source = ix.accounts?.[0]?.address
      const mint = ix.accounts?.[1]?.address
      const authority = ix.accounts?.[3]?.address
      if (!source || !mint || authority !== wallet) {
        throw new Error(`yield instruction ${index} has malformed TransferChecked metas`)
      }
      const [custodyAta] = await findAssociatedTokenPda({
        mint,
        owner: wallet,
        tokenProgram: address(program),
      })
      if (source !== custodyAta) {
        throw new Error(`yield instruction ${index} debits a non-custody source ${source}`)
      }
    }
  }
}

function toInstruction(raw: RawInstruction): Instruction {
  return {
    accounts: raw.accounts.map((account) => ({
      address: address(account.pubkey),
      role: account.isSigner
        ? account.isWritable
          ? AccountRole.WRITABLE_SIGNER
          : AccountRole.READONLY_SIGNER
        : account.isWritable
          ? AccountRole.WRITABLE
          : AccountRole.READONLY,
    })),
    data: Uint8Array.from(atob(raw.data), (char) => char.charCodeAt(0)),
    programAddress: address(raw.programId),
  }
}

function asInstructionList(body: unknown): RawInstruction[] {
  // Jupiter: { instructions: [...] }. Kamino ktx may return
  // { instructions: [...] } or a bare array.
  if (Array.isArray(body)) return body as RawInstruction[]
  const record = body as { instructions?: RawInstruction[] }
  if (Array.isArray(record.instructions)) return record.instructions
  throw new Error('yield API returned no instructions')
}

async function fetchInstructions(url: string, payload: Record<string, string>): Promise<Instruction[]> {
  let lastError: unknown = new Error('yield API unreachable')
  for (let attempt = 0; attempt < 4; attempt++) {
    let response: Response
    try {
      response = await fetch(url, {
        body: JSON.stringify(payload),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
    } catch (error) {
      // fetch itself rejected (network) — retryable.
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)))
      continue
    }
    if (response.ok) {
      // Parse/convert failures are not retryable and propagate as-is.
      return asInstructionList(await response.json()).map(toInstruction)
    }
    lastError = new Error(`yield API ${response.status}: ${(await response.text()).slice(0, 200)}`)
    if (response.status !== 429 && response.status < 500) throw lastError
    await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)))
  }
  throw lastError
}

// Instructions placing `units` of backing into the product's yield venue.
// `wallet` is the custody address — deposit pulls from its backing ATA,
// withdraw delivers to it.
export async function yieldInstructions(
  product: FimsWrappedProduct,
  action: YieldAction,
  config: WrappedProductConfig,
  wallet: Address,
  units: bigint,
): Promise<Instruction[]> {
  const type = yieldType(product)
  if (!type) return []

  const instructions =
    type === 'jupiter-earn'
      ? await fetchInstructions(`${JUPITER_EARN_API()}/${action}-instructions`, {
          amount: `${units}`,
          asset: `${config.backingMint}`,
          signer: wallet,
        })
      : await (async () => {
          // Kamino: amount is a decimal string, and the reserve must belong to
          // the configured market (OnReMarket for USDG).
          const market = process.env['FIMS_USD_YIELD_MARKET']
          const reserve = process.env['FIMS_USD_YIELD_RESERVE']
          if (!market || !reserve) {
            throw new Error('FIMS_USD_YIELD_MARKET / FIMS_USD_YIELD_RESERVE are not configured')
          }
          return fetchInstructions(`${KAMINO_KTX_API()}/klend/${action}-instructions`, {
            amount: `${Number(units) / 1e6}`,
            market,
            reserve,
            wallet,
          })
        })()

  await assertSafeYieldInstructions(type, instructions, wallet)
  return instructions
}
