import type { MessagePartialSigner } from '@solana/kit'
import { env } from '@workspace/env/env'
import { fimsInvalidateSession, fimsSessionToken } from '@workspace/solana-client/fims-session'

// Client for the API's /fims/chain/* proxy — Helius never sees the app and the
// app never sees the Helius key. Types mirror the Effect schemas in
// apps/api/src/routes/fims/api.ts (Chain*) and the Dexie cache row in
// packages/db/src/chain/chain-transaction.ts.

export interface ChainLabel {
  address: string
  kind: 'cex' | 'member' | 'other' | 'tontine' | 'treasury'
  label: string
}

export interface ChainTransfer {
  amount: number
  counterparty: null | string
  counterpartyLabel: null | string
  direction: 'in' | 'out'
  mint: null | string
  symbol: null | string
}

export interface ChainTransaction {
  description: string
  feeSol: number
  signature: string
  source: null | string
  timestamp: number
  transfers: ChainTransfer[]
  type: string
}

export interface ChainAsset {
  amount: number
  mint: null | string
  name: null | string
  symbol: null | string
  usdPrice: null | number
}

export class ChainApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ChainApiError'
    this.status = status
  }
}

function apiUrl(path: string, params?: Record<string, string>): URL {
  const url = new URL(`${env('apiEndpoint').replace(/\/+$/, '')}/fims${path}`)
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, value)
  }
  return url
}

async function chainFetch<T>(url: URL, headers?: Record<string, string>): Promise<T> {
  const res = await fetch(url, headers ? { headers } : undefined)
  if (!res.ok) {
    const body = await res.text()
    throw new ChainApiError(res.status, body.slice(0, 200))
  }
  return (await res.json()) as T
}

export async function chainGetLabels(signer: MessagePartialSigner): Promise<ChainLabel[]> {
  return chainSignedGet<ChainLabel[]>(signer, '/chain/labels')
}

// Authenticated GET via the SIWS bearer session: one wallet signature covers
// every chain read for 24h — per-request signing made external wallets
// pop a prompt per call (and concurrent prompts cancel each other).
async function chainSignedGet<T>(
  signer: MessagePartialSigner,
  path: string,
  params?: Record<string, string>,
): Promise<T> {
  const url = apiUrl(path, params)
  const apiEndpoint = env('apiEndpoint')
  try {
    const token = await fimsSessionToken(apiEndpoint, signer)
    return await chainFetch<T>(url, { authorization: `Bearer ${token}` })
  } catch (error) {
    if (!(error instanceof ChainApiError) || error.status !== 401) throw error
  }
  // The server may have dropped the session (restart, purge) — re-sign in
  // once, transparently.
  fimsInvalidateSession(apiEndpoint, signer)
  const token = await fimsSessionToken(apiEndpoint, signer)
  return chainFetch<T>(url, { authorization: `Bearer ${token}` })
}

export interface ChainHistoryPage {
  // Opaque provider cursor — pass back verbatim for the next page, null at end.
  cursor: null | string
  transactions: ChainTransaction[]
}

export async function chainGetHistory(
  signer: MessagePartialSigner,
  address: string,
  { cursor, limit }: { cursor?: string | undefined; limit?: number } = {},
): Promise<ChainHistoryPage> {
  const params: Record<string, string> = { address, limit: String(limit ?? 100) }
  if (cursor) params['cursor'] = cursor
  return chainSignedGet<ChainHistoryPage>(signer, '/chain/history', params)
}

export async function chainGetAssets(signer: MessagePartialSigner, address: string): Promise<ChainAsset[]> {
  return chainSignedGet<ChainAsset[]>(signer, '/chain/assets', { address })
}
