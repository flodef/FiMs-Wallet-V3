// cspell:ignore lamports
// Minimal Solana JSON-RPC reader for the worker — just enough to verify that a
// transaction really moved value into the tontine wallet before the ledger
// credits a donation. The endpoint is configurable because public RPCs rate
// limit hard; SOLANA_RPC_URL should point at the same provider the web app
// uses for mainnet.
//
// H-3 hardening:
//   - `finalized` is the default for anything that credits the ledger — a
//     `confirmed` transaction can still be reorged out after credit.
//   - FIMS_VERIFY_RPC_URL, when set, is a second INDEPENDENT provider: both
//     must agree on payer + deltas before anything is credited. A single
//     compromised/forged RPC response can no longer mint phantom deposits.
//   - Every delta is tagged `payerSourced`: the credited funds must have
//     LEFT accounts owned by the fee payer. Crediting `keys[0]` for a
//     transfer funded by an unrelated third party is vote/ledger spoofing.

const DEFAULT_RPC_URL = 'https://api.mainnet-beta.solana.com'

export interface DonationDelta {
  // Token units moved (mint = the token's mint address, or 'SOL').
  amount: number
  // Base units moved — the exact integer behind `amount` (SOL = lamports).
  decimals: number
  mint: string
  // True when accounts owned by the fee payer funded this credit — a delta
  // paid by an unrelated wallet must not be attributed to the payer.
  payerSourced: boolean
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

async function fetchParsedTransaction(
  rpcUrl: string,
  signature: string,
  commitment: 'confirmed' | 'finalized',
): Promise<ParsedTransaction | null> {
  const res = await fetch(rpcUrl, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: '2.0',
      method: 'getTransaction',
      // v0 is the newest wire version — anything newer must not parse.
      params: [signature, { commitment, encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  if (!res.ok) {
    throw new Error(`solana rpc failed: ${res.status}`)
  }
  const json = (await res.json()) as { result?: ParsedTransaction | null }
  return json.result ?? null
}

function parseDonation(tx: ParsedTransaction, tontine: string): VerifiedDonationTx | null {
  if (!tx.meta || tx.meta.err != null) {
    return null
  }

  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey))
  const payer = keys[0]
  if (!payer) {
    return null
  }

  // Source-side totals: how much LEFT accounts owned by the payer, per mint.
  // `keys[0]` funds the fee from lamports index 0; SPL sources are every
  // token balance owned by the payer that shrank across the transaction.
  const spentByPayer = new Map<string, bigint>()
  const payerPreLamports = BigInt(tx.meta.preBalances[0] ?? 0)
  const payerPostLamports = BigInt(tx.meta.postBalances[0] ?? 0)
  spentByPayer.set('SOL', payerPreLamports - payerPostLamports)
  const splSpent = new Map<string, bigint>()
  for (const bal of tx.meta.preTokenBalances) {
    if (bal.owner === payer) {
      splSpent.set(bal.mint, (splSpent.get(bal.mint) ?? 0n) + BigInt(bal.uiTokenAmount.amount))
    }
  }
  for (const bal of tx.meta.postTokenBalances) {
    if (bal.owner === payer) {
      splSpent.set(bal.mint, (splSpent.get(bal.mint) ?? 0n) - BigInt(bal.uiTokenAmount.amount))
    }
  }
  for (const [mint, spent] of splSpent) spentByPayer.set(mint, spent)

  const deltas: DonationDelta[] = []

  // SOL leg: lamports credited to the tontine account index.
  const tontineIndex = keys.indexOf(tontine)
  if (tontineIndex >= 0) {
    const lamports = (tx.meta.postBalances[tontineIndex] ?? 0) - (tx.meta.preBalances[tontineIndex] ?? 0)
    if (lamports > 0) {
      deltas.push({
        amount: lamports / 1e9,
        decimals: 9,
        mint: 'SOL',
        payerSourced: (spentByPayer.get('SOL') ?? 0n) >= BigInt(lamports),
        rawAmount: BigInt(lamports),
      })
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
      deltas.push({
        amount: Number(delta) / 10 ** post.decimals,
        decimals: post.decimals,
        mint,
        payerSourced: (spentByPayer.get(mint) ?? 0n) >= delta,
        rawAmount: delta,
      })
    }
  }

  return {
    blockTime: tx.blockTime ? new Date(tx.blockTime * 1000) : null,
    deltas,
    payer,
  }
}

// Canonical comparison key for dual-RPC concordance: two providers agree iff
// the credited result is identical down to raw units.
function resultKey(result: VerifiedDonationTx | null): string {
  if (!result) return 'null'
  const legs = result.deltas
    .map((d) => `${d.mint}:${d.rawAmount}:${d.payerSourced}`)
    .sort()
    .join('|')
  return `${result.payer}#${legs}`
}

export async function fetchDonationTransaction(
  signature: string,
  tontine: string,
  commitment: 'confirmed' | 'finalized' = 'finalized',
): Promise<VerifiedDonationTx | null> {
  const primaryUrl = process.env['SOLANA_RPC_URL'] ?? DEFAULT_RPC_URL
  const tx = await fetchParsedTransaction(primaryUrl, signature, commitment)
  const primary = tx ? parseDonation(tx, tontine) : null

  // Independent-provider concordance (H-3): when a second RPC is configured,
  // both must produce the SAME credited result — mismatch throws rather than
  // picking a side, because either provider could be the liar.
  const verifyUrl = process.env['FIMS_VERIFY_RPC_URL']
  if (verifyUrl && verifyUrl !== primaryUrl) {
    const verifyTx = await fetchParsedTransaction(verifyUrl, signature, commitment)
    const secondary = verifyTx ? parseDonation(verifyTx, tontine) : null
    if (resultKey(primary) !== resultKey(secondary)) {
      throw new Error(`rpc verification mismatch on ${signature}: providers disagree`)
    }
  }

  return primary
}
