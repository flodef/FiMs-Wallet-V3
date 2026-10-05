// Helius client — getTransactionsForAddress (GTFA) + DAS getAssetsByOwner on
// the RPC endpoint. GTFA returns raw transactions with meta: balance deltas
// are computed from pre/post token balances (owner-resolved) and native
// balances, which is more reliable than parsed tokenTransfers. The API key(s)
// stay server-side: clients call /fims/chain/* and never see HELIUS_API_KEY.

const HELIUS_RPC_URL = 'https://mainnet.helius-rpc.com/'
const LAMPORTS_PER_SOL = 1_000_000_000

// Comma-separated keys: HELIUS_API_KEY="key1,key2". The list is tried in
// order — a 401/403 (dead key) or 429 (exhausted) falls through to the next.
export function heliusApiKeys(env: Record<string, string | undefined> = process.env): string[] {
  return (env['HELIUS_API_KEY'] ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean)
}

async function heliusRpc<T>(keys: string[], method: string, params: unknown): Promise<T> {
  let lastError: unknown = null
  for (const key of keys) {
    const res = await fetch(`${HELIUS_RPC_URL}?api-key=${key}`, {
      body: JSON.stringify({ id: 'fims-chain', jsonrpc: '2.0', method, params }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    if (res.ok) {
      const body = (await res.json()) as { error?: { message?: string }; result?: T }
      if (body.error) {
        lastError = new Error(`helius ${method}: ${body.error.message ?? 'rpc error'}`)
        continue
      }
      if (body.result === undefined) throw new Error(`helius ${method}: empty result`)
      return body.result
    }
    if (res.status !== 401 && res.status !== 403 && res.status !== 429) {
      const text = await res.text()
      throw new Error(`helius ${method}: HTTP ${res.status} ${text.slice(0, 200)}`)
    }
    lastError = new Error(`helius ${method}: HTTP ${res.status}`)
  }
  throw lastError instanceof Error ? lastError : new Error('helius request failed')
}

// ─── GTFA (history) ─────────────────────────────────────────────────────────

interface GtfaTokenBalance {
  accountIndex: number
  mint: string
  owner?: string
  uiTokenAmount: { amount: string; decimals: number; uiAmount: null | number }
}

interface GtfaTransaction {
  blockTime?: number
  meta?: {
    err?: unknown
    fee?: number
    postBalances?: number[]
    postTokenBalances?: GtfaTokenBalance[]
    preBalances?: number[]
    preTokenBalances?: GtfaTokenBalance[]
  }
  transaction?: {
    message?: { accountKeys?: ({ pubkey?: string } | string)[] }
    signatures?: string[]
  }
}

export interface HeliusTxPage {
  data: GtfaTransaction[]
  paginationToken?: string
}

export async function fetchHeliusTransactions(
  keys: string[],
  address: string,
  { cursor, limit }: { cursor?: string | undefined; limit?: number | undefined } = {},
): Promise<HeliusTxPage> {
  return heliusRpc<HeliusTxPage>(keys, 'getTransactionsForAddress', [
    address,
    {
      // tokenAccounts:"balanceChanged" — without it GTFA misses transfers whose
      // only link to the wallet is an ATA balance change (e.g. inbound sends to
      // a freshly created token account never reference the owner address).
      filters: { tokenAccounts: 'balanceChanged' },
      limit: limit ?? 100,
      ...(cursor ? { paginationToken: cursor } : {}),
      sortOrder: 'desc',
      transactionDetails: 'full',
    },
  ])
}

export interface NormalizedTransfer {
  amount: number // positive, in UI units
  counterparty: null | string
  counterpartyLabel: null | string
  direction: 'in' | 'out'
  mint: null | string // null = native SOL
  symbol: null | string
}

export interface NormalizedTransaction {
  description: string
  feeSol: number
  signature: string
  source: null | string
  timestamp: number // unix seconds
  transfers: NormalizedTransfer[]
  type: string
}

// Mints that do not come from the tokens table but are worth naming.
const STATIC_SYMBOLS: Record<string, string> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
  HzwqbKZw8HxMN6bF2yFZNrht3c2iXXcyKpuPu7vVYrt: 'EURC',
}

export function chainSymbolForMint(mint: string, symbols: Map<string, string>): null | string {
  return symbols.get(mint) ?? STATIC_SYMBOLS[mint] ?? null
}

// Known DEX/aggregator programs — used to tag the tx source for display.
const KNOWN_PROGRAMS: Record<string, string> = {
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium',
  JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuTW: 'Jupiter',
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: 'Jupiter',
}

interface BalanceDelta {
  amount: number // signed
  mint: null | string
  owner: null | string
}

function tokenBalanceDeltas(meta: GtfaTransaction['meta']): BalanceDelta[] {
  const amounts = new Map<string, BalanceDelta>()
  const apply = (list: GtfaTokenBalance[] | undefined, sign: 1 | -1) => {
    for (const b of list ?? []) {
      const key = `${b.mint}|${b.owner ?? ''}`
      const entry = amounts.get(key) ?? { amount: 0, mint: b.mint, owner: b.owner ?? null }
      const ui = b.uiTokenAmount.uiAmount ?? Number(b.uiTokenAmount.amount) / 10 ** b.uiTokenAmount.decimals
      entry.amount += sign * ui
      amounts.set(key, entry)
    }
  }
  apply(meta?.postTokenBalances, 1)
  apply(meta?.preTokenBalances, -1)
  return [...amounts.values()].filter((d) => Math.abs(d.amount) > 1e-12)
}

// Counterparty for a leg: the owner of the largest opposite delta on the same
// mint, else null (swap pool vaults and intermediary ATAs stay anonymous).
function counterpartyFor(mint: null | string, direction: 'in' | 'out', deltas: BalanceDelta[]): null | string {
  let best: BalanceDelta | null = null
  for (const d of deltas) {
    if (d.mint !== mint || !d.owner) continue
    const opposite = direction === 'in' ? d.amount < 0 : d.amount > 0
    if (opposite && (!best || Math.abs(d.amount) > Math.abs(best.amount))) best = d
  }
  return best?.owner ?? null
}

export function normalizeGtfaTransaction(
  tx: GtfaTransaction,
  address: string,
  labels: Map<string, string>,
  symbols: Map<string, string>,
): NormalizedTransaction | null {
  const signature = tx.transaction?.signatures?.[0]
  const timestamp = tx.blockTime
  if (!signature || typeof timestamp !== 'number' || tx.meta?.err) return null

  const meta = tx.meta ?? {}
  const tokenDeltas = tokenBalanceDeltas(meta)

  // Native SOL delta for the watched account (fee included when it paid).
  const deltas = [...tokenDeltas]
  const keys = tx.transaction?.message?.accountKeys ?? []
  const ownIndex = keys.findIndex((k) => (typeof k === 'string' ? k : k.pubkey) === address)
  if (ownIndex >= 0) {
    const pre = meta.preBalances?.[ownIndex] ?? 0
    const post = meta.postBalances?.[ownIndex] ?? 0
    const delta = (post - pre) / LAMPORTS_PER_SOL
    if (Math.abs(delta) > 1e-12) deltas.push({ amount: delta, mint: null, owner: address })
  }

  const transfers: NormalizedTransfer[] = []
  for (const d of tokenDeltas) {
    if (d.owner !== address) continue
    const direction = d.amount > 0 ? 'in' : 'out'
    const counterparty = counterpartyFor(d.mint, direction, deltas)
    transfers.push({
      amount: Math.abs(d.amount),
      counterparty,
      counterpartyLabel: counterparty ? (labels.get(counterparty) ?? null) : null,
      direction,
      mint: d.mint,
      symbol: chainSymbolForMint(d.mint ?? '', symbols),
    })
  }
  // SOL leg: skip the fee-only dust (payer paying just the fee is not a transfer).
  const sol = deltas.find((d) => d.mint === null && d.owner === address)
  const fee = (meta.fee ?? 0) / LAMPORTS_PER_SOL
  if (sol && Math.abs(sol.amount) > fee) {
    const direction = sol.amount > 0 ? 'in' : 'out'
    const counterparty = counterpartyFor(null, direction, deltas)
    transfers.push({
      amount: Math.abs(sol.amount) + (direction === 'out' ? -fee : 0),
      counterparty,
      counterpartyLabel: counterparty ? (labels.get(counterparty) ?? null) : null,
      direction,
      mint: null,
      symbol: 'SOL',
    })
  }

  const programs = keys
    .map((k) => (typeof k === 'string' ? k : (k.pubkey ?? '')))
    .map((k) => KNOWN_PROGRAMS[k])
    .filter(Boolean)
  const mixed = transfers.some((t) => t.direction === 'in') && transfers.some((t) => t.direction === 'out')

  return {
    description: '',
    feeSol: fee,
    signature,
    source: programs[0] ?? null,
    timestamp,
    transfers,
    // No parsed type in GTFA — both-directions flow is treated as a swap for
    // P&L counter-value attribution, everything else is a transfer.
    type: mixed ? 'SWAP' : 'TRANSFER',
  }
}

// ─── DAS (current balances + prices) ────────────────────────────────────────

export interface ChainAsset {
  amount: number
  mint: null | string // null = native SOL
  name: null | string
  symbol: null | string
  usdPrice: null | number
}

interface DasAsset {
  content?: { metadata?: { name?: string; symbol?: string } }
  id?: string
  token_info?: {
    balance?: number
    decimals?: number
    price_info?: { price_per_token?: number }
  }
}

interface DasAssetsByOwner {
  items?: DasAsset[]
  nativeBalance?: { lamports?: number; price_per_sol?: number }
}

export async function fetchHeliusAssets(keys: string[], address: string): Promise<ChainAsset[]> {
  const result = await heliusRpc<DasAssetsByOwner>(keys, 'getAssetsByOwner', {
    displayOptions: { showFungible: true, showNativeBalance: true },
    ownerAddress: address,
  })
  const assets: ChainAsset[] = []
  const native = result.nativeBalance
  if (typeof native?.lamports === 'number' && native.lamports > 0) {
    assets.push({
      amount: native.lamports / LAMPORTS_PER_SOL,
      mint: null,
      name: 'Solana',
      symbol: 'SOL',
      usdPrice: native.price_per_sol ?? null,
    })
  }
  for (const item of result.items ?? []) {
    const info = item.token_info
    if (!item.id || typeof info?.balance !== 'number' || typeof info.decimals !== 'number') continue
    assets.push({
      amount: info.balance / 10 ** info.decimals,
      mint: item.id,
      name: item.content?.metadata?.name ?? null,
      symbol: item.content?.metadata?.symbol ?? null,
      usdPrice: info.price_info?.price_per_token ?? null,
    })
  }
  return assets
}
