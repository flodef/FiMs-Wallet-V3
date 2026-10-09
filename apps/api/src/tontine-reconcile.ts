// Tontine reconciliation — runs inside the keeper pass so the ledger learns
// about every on-chain credit to the pot, not only the carve a member's own
// send carried. A member who settles their debt from Phantom, or a send
// whose client never called recordDonation, is recorded just the same:
// the chain is the source of truth, the API call a fast path.
import { eq, sql } from 'drizzle-orm'
import { tokens, transactions, usedSignatures, userAddresses, users } from './db/schema.js'
import type { Db } from './db/service.js'
import { fetchDonationTransaction } from './solana-rpc.js'

// Same pot address as routes/fims/http.ts and feature-fims constants.
const FIMS_TONTINE_ADDRESS = 'Fe1RpesrtYMJdjwbNXtpVCDNpnFvk6jSic3sJd2aCBng'
const DEFAULT_RPC_URL = 'https://api.mainnet-beta.solana.com'
// Scan horizon: the pot is quiet — 20 signatures covers weeks of activity.
const SCAN_LIMIT = 20

async function listPotSignatures(): Promise<string[]> {
  const res = await fetch(process.env['SOLANA_RPC_URL'] ?? DEFAULT_RPC_URL, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: '2.0',
      method: 'getSignaturesForAddress',
      params: [FIMS_TONTINE_ADDRESS, { limit: SCAN_LIMIT }],
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  if (!res.ok) throw new Error(`solana rpc failed: ${res.status}`)
  const json = (await res.json()) as { result?: { signature: string }[] }
  return (json.result ?? []).map((row) => row.signature)
}

// Same linked-address resolution the HTTP handlers use — duplicated rather
// than imported to keep the reconcile free of route dependencies.
const memberLinkedTo = (db: Db, address: string) =>
  db
    .select({ id: users.id })
    .from(users)
    .where(
      sql`(${users.address} = ${address}) or exists (select 1 from ${userAddresses} where ${userAddresses.userId} = ${users.id} and ${userAddresses.address} = ${address})`,
    )
    .limit(1)

/**
 * For each recent signature on the tontine wallet: fetch the transaction,
 * verify it credited the pot, resolve the fee payer to a member and insert
 * the donation rows — claimed by `donation:{signature}` so the HTTP
 * recordDonation endpoint and this reconcile never double-write.
 */
export async function reconcileTontineDonations(db: Db): Promise<{ recorded: number; scanned: number }> {
  const signatures = await listPotSignatures()
  const tokenRows = await db.select().from(tokens)
  const priceOf = (symbol: string) => tokenRows.find((t) => t.symbol === symbol)?.value ?? null
  const symbolOf = (mint: string) =>
    mint === 'SOL' ? 'SOL' : (tokenRows.find((t) => t.address === mint)?.symbol ?? null)

  let recorded = 0
  for (const signature of signatures) {
    const seen = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(eq(transactions.signature, signature))
    if (seen.length) continue
    const fetched = await fetchDonationTransaction(signature, FIMS_TONTINE_ADDRESS).catch(() => null)
    if (!fetched?.deltas.length) continue
    const member = (await memberLinkedTo(db, fetched.payer))[0]
    // Not a member's gift — external senders stay unrecorded (no ledger owner).
    if (!member) continue
    const claimed = await db.transaction(async (tx) => {
      const claim = await tx
        .insert(usedSignatures)
        .values({ signature: `donation:${signature}` })
        .onConflictDoNothing()
        .returning()
      if (!claim.length) return false
      const committed = await tx
        .select({ id: transactions.id })
        .from(transactions)
        .where(eq(transactions.signature, signature))
      if (committed.length) return false
      await tx.insert(transactions).values(
        fetched.deltas.map((delta) => {
          const symbol = symbolOf(delta.mint)
          const movement = symbol ? (priceOf(symbol) ?? 0) * delta.amount : 0
          return {
            address: fetched.payer,
            amount: delta.amount,
            cost: movement,
            date: fetched.blockTime ?? new Date(),
            donationTarget: 'tontine',
            movement,
            signature,
            token: symbol,
            type: 'donation' as const,
            userId: member.id,
          }
        }),
      )
      return true
    })
    if (claimed) recorded += 1
  }
  return { recorded, scanned: signatures.length }
}
