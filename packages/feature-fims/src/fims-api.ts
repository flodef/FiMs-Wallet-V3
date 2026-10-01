import { getBase64Decoder, type KeyPairSigner } from '@solana/kit'

// Types mirror the Effect schemas in apps/api/src/routes/fims/api.ts
export interface FimsUser {
  address: string
  createdAt: string
  id: number
  isPro: boolean
  isPublic: boolean
  name: string
  profileUpdatedAt: null | string
  riskTarget: null | number
  updatedAt: string
}

export type FimsTransactionType =
  | 'cex_in'
  | 'cex_out'
  | 'conversion'
  | 'deposit'
  | 'donation'
  | 'payment'
  | 'tontine'
  | 'withdrawal'

export interface FimsTransaction {
  address: string
  amount: null | number
  cost: number
  createdAt: string
  date: string
  donationTarget: null | string
  id: number
  movement: number
  signature: null | string
  token: null | string
  type: FimsTransactionType | null
  userId: null | number
}

export interface FimsToken {
  address: null | string
  description: null | string
  duration: null | number
  inceptionPrice: null | number
  inceptionRatio: null | number
  label: string
  symbol: string
  updatedAt: string
  value: null | number
  volatility: null | number
  yearlyYield: null | number
}

export interface FimsDashboardMetric {
  label: string
  ratio: null | number
  value: number
}

export interface FimsHistoricPoint {
  date: string
  invested: number
  treasury: null | number
}

export interface FimsUserHistoricPoint {
  date: string
  invested: number
  total: null | number
  userId: number
}

export interface FimsPricePoint {
  date: string
  price: number
  token: string
}

export type FimsAddressBookType = 'binance' | 'coinbase' | 'fimseur' | 'nexo' | 'other'

export interface FimsAddressBookEntry {
  address: string
  createdAt: string
  id: number
  label: string
  type: FimsAddressBookType
  userId: number
}

export type FimsVoteKind = 'investment' | 'tontine'
export type FimsVoteStatus = 'closed' | 'draft' | 'open'

export interface FimsVoteOption {
  ballots: number
  id: number
  label: string
  sortOrder: number
  weight: number
}

export interface FimsVote {
  closesAt: null | string
  createdAt: string
  description: null | string
  id: number
  kind: FimsVoteKind
  myOptionId: null | number
  options: FimsVoteOption[]
  status: FimsVoteStatus
  title: string
  totalWeight: number
}

export class FimsApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'FimsApiError'
    this.status = status
  }
}

export async function fimsGet<T>(apiEndpoint: string, path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`${apiEndpoint.replace(/\/+$/, '')}/fims${path}`)
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, value)
  }
  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.text()
    throw new FimsApiError(res.status, body.slice(0, 200))
  }
  return (await res.json()) as T
}

// The API bounds every list response (MAX_PAGE_SIZE server-side). This helper
// walks limit/offset pages until a short page marks the end, so callers keep
// getting the full dataset.
export const FIMS_PAGE_SIZE = 2000

export async function fimsGetAll<T>(
  apiEndpoint: string,
  path: string,
  params?: Record<string, string>,
  fetchPage: (params: Record<string, string>) => Promise<T[]> = (p) => fimsGet<T[]>(apiEndpoint, path, p),
): Promise<T[]> {
  const rows: T[] = []
  let offset = 0
  for (;;) {
    const page = await fetchPage({ ...params, limit: String(FIMS_PAGE_SIZE), offset: String(offset) })
    rows.push(...page)
    if (page.length < FIMS_PAGE_SIZE) return rows
    offset += FIMS_PAGE_SIZE
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// Requests are authenticated by a wallet signature, verified by the API.
// The signer signs:
//   `fims-wallet-v3\n{HOST}\n{METHOD}\n{PATHNAME}\n{TIMESTAMP_MS}\n{SHA256_HEX(BODY)}`
// Binding the host prevents signatures captured on a rogue endpoint from being
// replayed against the real API; binding the body hash prevents replay with a
// swapped payload.
async function fimsAuthHeaders(
  apiEndpoint: string,
  signer: KeyPairSigner,
  method: 'DELETE' | 'GET' | 'PATCH' | 'POST',
  path: string,
  bodyText: string,
): Promise<Record<string, string>> {
  const ts = Date.now()
  const host = new URL(apiEndpoint).host
  const bodyHash = await sha256Hex(bodyText)
  const content = new TextEncoder().encode(`fims-wallet-v3\n${host}\n${method}\n/fims${path}\n${ts}\n${bodyHash}`)
  const [signatures] = await signer.signMessages([{ content, signatures: {} }])
  const signature = signatures?.[signer.address]
  if (!signature) {
    throw new FimsApiError(401, 'wallet did not sign the request')
  }
  return {
    'x-fims-address': signer.address,
    'x-fims-sig': getBase64Decoder().decode(signature),
    'x-fims-ts': String(ts),
  }
}

// Signed GET: required to read private member data (the API only serves
// non-public users' rows to the owner or an admin).
export async function fimsSignedGet<T>(
  apiEndpoint: string,
  signer: KeyPairSigner,
  path: string,
  params?: Record<string, string>,
): Promise<T> {
  const url = new URL(`${apiEndpoint.replace(/\/+$/, '')}/fims${path}`)
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, value)
  }
  const headers = await fimsAuthHeaders(apiEndpoint, signer, 'GET', path, '')
  const res = await fetch(url, { headers })
  if (!res.ok) {
    const text = await res.text()
    throw new FimsApiError(res.status, text.slice(0, 200))
  }
  return (await res.json()) as T
}

export async function fimsSignedGetAll<T>(
  apiEndpoint: string,
  signer: KeyPairSigner,
  path: string,
  params?: Record<string, string>,
): Promise<T[]> {
  return fimsGetAll<T>(apiEndpoint, path, params, (p) => fimsSignedGet<T[]>(apiEndpoint, signer, path, p))
}

export async function fimsSignedFetch<T>(
  apiEndpoint: string,
  signer: KeyPairSigner,
  method: 'DELETE' | 'PATCH' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const bodyText = body === undefined ? '' : JSON.stringify(body)
  const headers = await fimsAuthHeaders(apiEndpoint, signer, method, path, bodyText)

  const url = `${apiEndpoint.replace(/\/+$/, '')}/fims${path}`
  const res = await fetch(url, {
    body: body === undefined ? null : bodyText,
    headers: { 'content-type': 'application/json', ...headers },
    method,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new FimsApiError(res.status, text.slice(0, 200))
  }
  return (await res.json()) as T
}
