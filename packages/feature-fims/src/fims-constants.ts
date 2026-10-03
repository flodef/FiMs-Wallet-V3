// FiMs treasury wallet — public, safe to embed in the bundle.
export const FIMS_TREASURY_ADDRESS = '58kZBjjtHShTtXFmygr3ZT8VSU4dH28PanRAdouHbToh'

// Public portfolio/audit view of the treasury on Jupiter.
export const FIMS_AUDIT_URL = `https://jup.ag/portfolio/${FIMS_TREASURY_ADDRESS}`

// The .sol domain expected to resolve to the treasury address. Only displayed
// next to the audit link when the on-chain record actually points there.
export const FIMS_TREASURY_DOMAIN = 'fimsfi.sol' as const

// Legacy spreadsheet rule: members owe 10% of their gains to FiMs (donation to
// the Tontine or a charity of their choice).
export const FIMS_DONATION_RATIO = 0.1

// Operating fee deducted from the credited side of conversions and from
// withdrawals: 0.1% stays in the treasury. Mirrors FIMS_FEE_RATE in the API.
export const FIMS_FEE_RATE = 0.001

// Canonical mainnet mints for the major assets a member swaps into, pinned
// client-side so a compromised API token row cannot point "USDC" at a fake
// mint. Symbols we cannot pin (FiMs' own tokens) simply have no entry — the
// check only bites for symbols we DO pin.
export const FIMS_KNOWN_MINTS: Readonly<Record<string, string>> = {
  cbBTC: 'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij',
  EURC: 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr',
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
}

// Off-ramp destinations the wallet knows about. A send to one of these is
// checked against the assets the service actually accepts: if the outgoing
// token is not on the list, the send is routed through a Jupiter swap whose
// output lands directly in the destination's token account (single tx).
// acceptedMints is ordered by preference — the first entry is what
// unsupported sends are converted into (EURC before USDC for exchanges,
// USDC before USDT for Jupiter Spend).
export const FIMS_WITHDRAWAL_PROVIDERS = {
  coinbase: { acceptedSymbols: ['EURC', 'USDC', 'SOL', 'cbBTC'] },
  nexo: { acceptedSymbols: ['USDC', 'SOL'] },
} as const

export type FimsExchangeProvider = keyof typeof FIMS_WITHDRAWAL_PROVIDERS

export const FIMS_JUPITER_SPEND_SYMBOLS = ['USDC', 'USDT'] as const

// Decimals for the pinned mints above, used to display swap output amounts.
export const FIMS_MINT_DECIMALS: Readonly<Record<string, number>> = {
  cbBTC: 8,
  EURC: 6,
  SOL: 9,
  USDC: 6,
  USDT: 6,
}

// Swaps quoting a worse price impact are refused: a huge impact means a
// manipulated route or an illiquid fake mint.
export const FIMS_MAX_PRICE_IMPACT = 0.03

// Guided-tour demo address, derived from the public demo mnemonic. Its keys
// are public knowledge — nothing of value may ever leave or rely on it.
export const FIMS_DEMO_ADDRESS = '5F86TNSTre3CYwZd1wELsGQGhqG2HkN3d8zxhbyBSnzm'
