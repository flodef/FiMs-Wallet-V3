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

function yieldType(product: FimsWrappedProduct): 'jupiter-earn' | 'kamino' | null {
  const value = process.env[PRODUCT_YIELD[product].typeEnv]
  return value === 'jupiter-earn' || value === 'kamino' ? value : null
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

  if (type === 'jupiter-earn') {
    return fetchInstructions(`${JUPITER_EARN_API()}/${action}-instructions`, {
      amount: `${units}`,
      asset: `${config.backingMint}`,
      signer: wallet,
    })
  }

  // Kamino: amount is a decimal string, and the reserve must belong to the
  // configured market (OnReMarket for USDG).
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
}
