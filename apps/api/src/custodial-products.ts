// cspell:ignore mints
// Product registry for the wrapped FiMs stable products: backing mint
// (EURC/USDG) → Token-2022 product mint + ledger symbol. Overridable via
// env so devnet can point at test mints (scripts/create-fims-mints.ts).
import { type Address, address } from '@solana/kit'

const EURC_MINT = 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr'
const USDG_MINT = '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH'

export type FimsWrappedProduct = 'fims-eur' | 'fims-usd'

export interface WrappedProductConfig {
  // Mint the member deposits / gets back on redeem.
  backingMint: Address
  // Token-2022 mint held by the custodial keypair.
  mint: Address
  // Product ticker — ledger rows and the price index use this symbol.
  symbol: string
  // All four tokens use 6 decimals.
  units: bigint
}

export const PRODUCTS: Record<
  FimsWrappedProduct,
  { backingEnv: string; backingFallback: string; mintEnv: string; symbol: string }
> = {
  'fims-eur': {
    backingEnv: 'FIMS_EURO_BACKING_MINT',
    backingFallback: EURC_MINT,
    mintEnv: 'FIMS_EURO_MINT',
    symbol: 'EURF',
  },
  'fims-usd': {
    backingEnv: 'FIMS_USD_BACKING_MINT',
    backingFallback: USDG_MINT,
    mintEnv: 'FIMS_USD_MINT',
    symbol: 'USDF',
  },
}

export function wrappedProductConfig(product: FimsWrappedProduct): WrappedProductConfig | null {
  const def = PRODUCTS[product]
  const mint = process.env[def.mintEnv]
  if (!mint) return null
  return {
    backingMint: address(process.env[def.backingEnv] || def.backingFallback),
    mint: address(mint),
    symbol: def.symbol,
    units: 1_000_000n,
  }
}

// Every backing mint a deposit may carry, resolved to its product. A tx that
// credits custody with anything else is not a valid wrapped deposit.
export function productForBackingMint(mint: string): FimsWrappedProduct | null {
  for (const product of Object.keys(PRODUCTS) as FimsWrappedProduct[]) {
    const config = wrappedProductConfig(product)
    if (config && config.backingMint === mint) return product
  }
  return null
}

export function productForWrappedMint(mint: string): FimsWrappedProduct | null {
  for (const product of Object.keys(PRODUCTS) as FimsWrappedProduct[]) {
    const config = wrappedProductConfig(product)
    if (config && config.mint === mint) return product
  }
  return null
}
