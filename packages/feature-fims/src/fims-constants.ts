// FiMs treasury wallet — public, safe to embed in the bundle.
export const FIMS_TREASURY_ADDRESS = '58kZBjjtHShTtXFmygr3ZT8VSU4dH28PanRAdouHbToh'

// Public portfolio/audit view of the treasury on Jupiter.
export const FIMS_AUDIT_URL = `https://jup.ag/portfolio/${FIMS_TREASURY_ADDRESS}`

// The .sol domain expected to resolve to the treasury address. Only displayed
// next to the audit link when the on-chain record actually points there.
export const FIMS_TREASURY_DOMAIN = 'fimsfi.sol' as const

// The tontine share of gains and the FiMs operating fee live in
// fims-fee-config.ts (getFimsTontineRate / getFimsFeeRate /
// getFimsPlatformFeeBps) — they are changeable rates, not fixed constants.

// Canonical mainnet mints for the major assets a member swaps into, pinned
// client-side so a compromised API token row cannot point "USDC" at a fake
// mint. Symbols we cannot pin (FiMs' own tokens) simply have no entry — the
// check only bites for symbols we DO pin.
export const FIMS_KNOWN_MINTS: Readonly<Record<string, string>> = {
  cbBTC: 'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij',
  DSOL: 'Dso1bDeDjCQxTrWHqUUi63oBvV7Mdm6WaobLbQ7gnPQ',
  ETH: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
  EURC: 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr',
  FiMs: 'D84wZMJRoievKkRaquXXrYSMuU5mA46RznCSrJ9HSK1u',
  FLiP: 'FLiPpMfKenthVe7XHAE41msm5t63R5EwpUi5Swo5qjpN',
  FSOL: '6hoGUYo5VengrsRtyyvs2y7KPf4mwWdv7V8C7GJg6Uy',
  JLP: '27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4',
  JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  JUPSOL: 'jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v',
  PYUSD: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDS: 'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  xBTC: 'CtzPWv73Sn1dMGVU3ZtLv9yWSyUAanBni19YWDaznnkn',
  ZEC: 'A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS',
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
  DSOL: 9,
  ETH: 8,
  EURC: 6,
  FiMs: 9,
  FLiP: 9,
  FSOL: 9,
  JLP: 6,
  JUP: 6,
  JUPSOL: 9,
  PYUSD: 6,
  SOL: 9,
  USDC: 6,
  USDS: 6,
  USDT: 6,
  xBTC: 8,
  ZEC: 8,
}

// Swaps quoting a worse price impact are refused: a huge impact means a
// manipulated route or an illiquid fake mint.
export const FIMS_MAX_PRICE_IMPACT = 0.03

// Guided-tour demo address, derived from the public demo mnemonic. Its keys
// are public knowledge — nothing of value may ever leave or rely on it.
export const FIMS_DEMO_ADDRESS = '5F86TNSTre3CYwZd1wELsGQGhqG2HkN3d8zxhbyBSnzm'

// FSOL mint — where accidental excess SOL above the gas reserve is proposed
// to be parked (FiMs' own SOL wrapper; a spreadsheet token, so it stays
// swappable in both directions).
export const FIMS_FSOL_MINT = FIMS_KNOWN_MINTS['FSOL'] ?? ''

// SOL is gas-only in this wallet: it pays network fees and account rent.
// The reserve kept back from every swap/convert proposal is 0.01 SOL.
export const FIMS_SOL_GAS_RESERVE = 10_000_000n
