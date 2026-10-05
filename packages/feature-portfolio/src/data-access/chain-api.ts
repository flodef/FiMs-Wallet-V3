import { getBase64Decoder, type MessagePartialSigner } from '@solana/kit'
import { env } from '@workspace/env/env'

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

// Duplicated from packages/feature-fims/src/fims-canonical-query.ts — the API
// verifies signatures against this exact canonicalization, so both must match.
function canonicalizeQuery(searchParams: URLSearchParams): string {
  const pairs = [...searchParams.entries()]
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1))
  return new URLSearchParams(pairs).toString()
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
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

// Signed GET — same scheme as fimsSignedGet: the wallet signs
//   fims-wallet-v3\n{HOST}\nGET\n{PATHNAME[?CANONICAL_QUERY]}\n{TS_MS}\n{SHA256_HEX('')}
async function chainSignedGet<T>(
  signer: MessagePartialSigner,
  path: string,
  params?: Record<string, string>,
): Promise<T> {
  const url = apiUrl(path, params)
  const ts = Date.now()
  const host = url.host
  const bodyHash = await sha256Hex('')
  const query = canonicalizeQuery(url.searchParams)
  const resource = query ? `/fims${path}?${query}` : `/fims${path}`
  const content = new TextEncoder().encode(`fims-wallet-v3\n${host}\nGET\n${resource}\n${ts}\n${bodyHash}`)
  const [signatures] = await signer.signMessages([{ content, signatures: {} }])
  const signature = signatures?.[signer.address]
  if (!signature) {
    throw new ChainApiError(401, 'wallet did not sign the request')
  }
  return chainFetch<T>(url, {
    'x-fims-address': signer.address,
    'x-fims-sig': getBase64Decoder().decode(signature),
    'x-fims-ts': String(ts),
  })
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
