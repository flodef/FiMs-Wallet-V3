// cspell:ignore lamports
// Minimal Solana JSON-RPC reader for the worker — just enough to verify that a
// transaction really moved value into the tontine wallet before the ledger
// credits a donation. The endpoint is configurable because public RPCs rate
// limit hard; SOLANA_RPC_URL should point at the same provider the web app
// uses for mainnet.

const DEFAULT_RPC_URL = 'https://api.mainnet-beta.solana.com'

export interface DonationDelta {
  // Token units moved (mint = the token's mint address, or 'SOL').
  amount: number
  // Base units moved — the exact integer behind `amount` (SOL = lamports).
  decimals: number
  mint: string
  rawAmount: bigint
}

export interface VerifiedDonationTx {
  blockTime: Date | null
  // Value received by the tontine wallet, per mint. Empty when the
  // transaction failed or credited nothing to the tontine.
  deltas: DonationDelta[]
  // First signer (fee payer) — the address the donation must be attributed to.
  payer: string
}

interface TokenBalance {
  accountIndex: number
  mint: string
  owner?: string | undefined
  uiTokenAmount: { amount: string; decimals: number; uiAmount?: number | null }
}

interface ParsedTransaction {
  blockTime?: number | null
  meta: {
    err: unknown
    postBalances: number[]
    postTokenBalances: TokenBalance[]
    preBalances: number[]
    preTokenBalances: TokenBalance[]
  } | null
  transaction: {
    message: {
      accountKeys: { pubkey: string; signer?: boolean }[] | string[]
    }
  }
}

export async function fetchDonationTransaction(
  signature: string,
  tontine: string,
  commitment: 'confirmed' | 'finalized' = 'confirmed',
): Promise<VerifiedDonationTx | null> {
  const res = await fetch(process.env['SOLANA_RPC_URL'] ?? DEFAULT_RPC_URL, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: '2.0',
      method: 'getTransaction',
      params: [signature, { commitment, encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 }],
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  if (!res.ok) {
    throw new Error(`solana rpc failed: ${res.status}`)
  }
  const json = (await res.json()) as { result?: ParsedTransaction | null }
  const tx = json.result
  if (!tx?.meta || tx.meta.err != null) {
    return null
  }

  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey))
  const payer = keys[0]
  if (!payer) {
    return null
  }

  const deltas: DonationDelta[] = []

  // SOL leg: lamports credited to the tontine account index.
  const tontineIndex = keys.indexOf(tontine)
  if (tontineIndex >= 0) {
    const lamports = (tx.meta.postBalances[tontineIndex] ?? 0) - (tx.meta.preBalances[tontineIndex] ?? 0)
    if (lamports > 0) {
      deltas.push({ amount: lamports / 1e9, decimals: 9, mint: 'SOL', rawAmount: BigInt(lamports) })
    }
  }

  // SPL legs: token balance deltas of every account owned by the tontine.
  const preByMint = new Map<string, bigint>()
  for (const bal of tx.meta.preTokenBalances) {
    if (bal.owner === tontine) {
      preByMint.set(bal.mint, (preByMint.get(bal.mint) ?? 0n) + BigInt(bal.uiTokenAmount.amount))
    }
  }
  const postByMint = new Map<string, { amount: bigint; decimals: number }>()
  for (const bal of tx.meta.postTokenBalances) {
    if (bal.owner === tontine) {
      const prev = postByMint.get(bal.mint)
      postByMint.set(bal.mint, {
        amount: (prev?.amount ?? 0n) + BigInt(bal.uiTokenAmount.amount),
        decimals: bal.uiTokenAmount.decimals,
      })
    }
  }
  for (const [mint, post] of postByMint) {
    const delta = post.amount - (preByMint.get(mint) ?? 0n)
    if (delta > 0n) {
      deltas.push({ amount: Number(delta) / 10 ** post.decimals, decimals: post.decimals, mint, rawAmount: delta })
    }
  }

  return {
    blockTime: tx.blockTime ? new Date(tx.blockTime * 1000) : null,
    deltas,
    payer,
  }
}
