import { getBase64Decoder, type MessagePartialSigner } from '@solana/kit'
import { canonicalResource } from './fims-canonical-query.ts'

// Types mirror the Effect schemas in apps/api/src/routes/fims/api.ts
export interface FimsUser {
  address: string
  // Canonical + linked wallet addresses — only present on the list endpoint.
  addresses?: string[]
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

// Extra wallet linked to a member (multi-wallet: one user, several wallets).
export interface FimsUserAddress {
  address: string
  createdAt: string
  id: number
  userId: number
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
  // Sum of every member's voting weight for this vote kind — the
  // denominator of `myWeight`.
  eligibleWeight: number
  id: number
  kind: FimsVoteKind
  myOptionId: null | number
  // Caller's voting weight for this vote kind (null when unsigned).
  myWeight: null | number
  options: FimsVoteOption[]
  // Member who submitted the proposal (null for admin-created votes).
  proposerId: null | number
  proposerName: null | string
  status: FimsVoteStatus
  title: string
  totalWeight: number
}

export interface FimsConfig {
  // Share of total invested assets a member must exceed to submit a tontine
  // proposal (0.01 = more than 1%). Admin-tunable via PATCH /fims/config.
  proposalThreshold: number
  // Sum of every member's latest invested amount — eligibility is
  // memberInvested > proposalThreshold × totalInvested.
  totalInvested: number
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
//   `fims-wallet-v3\n{HOST}\n{METHOD}\n{PATHNAME[?CANONICAL_QUERY]}\n{TIMESTAMP_MS}\n{SHA256_HEX(BODY)}`
// Binding the host prevents signatures captured on a rogue endpoint from being
// replayed against the real API; binding the canonical query prevents replaying
// a signed GET with swapped parameters; binding the body hash prevents replay
// with a swapped payload.
async function fimsAuthHeaders(
  apiEndpoint: string,
  signer: MessagePartialSigner,
  method: 'DELETE' | 'GET' | 'PATCH' | 'POST',
  resource: string,
  bodyText: string,
): Promise<Record<string, string>> {
  const ts = Date.now()
  const host = new URL(apiEndpoint).host
  const bodyHash = await sha256Hex(bodyText)
  const content = new TextEncoder().encode(`fims-wallet-v3\n${host}\n${method}\n${resource}\n${ts}\n${bodyHash}`)
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
  signer: MessagePartialSigner,
  path: string,
  params?: Record<string, string>,
): Promise<T> {
  const url = new URL(`${apiEndpoint.replace(/\/+$/, '')}/fims${path}`)
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, value)
  }
  let headers = await fimsAuthHeaders(
    apiEndpoint,
    signer,
    'GET',
    canonicalResource(`/fims${path}`, url.searchParams),
    '',
  )
  let res = await fetch(url, { headers })
  if (res.status === 401 && url.searchParams.size) {
    // Transitional: an API deployed before query binding rejects the canonical
    // signature. Retry once with the legacy path-only signature — signing is
    // local and silent, so the fallback is invisible. Remove once the worker
    // runs query-bound verification everywhere.
    headers = await fimsAuthHeaders(apiEndpoint, signer, 'GET', `/fims${path}`, '')
    res = await fetch(url, { headers })
  }
  if (!res.ok) {
    const text = await res.text()
    throw new FimsApiError(res.status, text.slice(0, 200))
  }
  return (await res.json()) as T
}

export async function fimsSignedGetAll<T>(
  apiEndpoint: string,
  signer: MessagePartialSigner,
  path: string,
  params?: Record<string, string>,
): Promise<T[]> {
  return fimsGetAll<T>(apiEndpoint, path, params, (p) => fimsSignedGet<T[]>(apiEndpoint, signer, path, p))
}

// Canonical consent message the NEW wallet signs to accept being linked to a
// member — must match the server-side builder in apps/api routes/fims/http.ts.
// Binding the user id prevents a consent signature captured on one link
// request from being replayed to attach the address to a different member.
export const fimsLinkAddressMessage = (userId: number, address: string) =>
  new TextEncoder().encode(`fims-wallet-v3\nlink-address\n${userId}\n${address}`)

// Raw ed25519 signature over arbitrary content (base64), separate from the
// request signature: proves the NEW wallet consents to being linked.
export async function fimsSignMessage(signer: MessagePartialSigner, content: Uint8Array): Promise<string> {
  const [signatures] = await signer.signMessages([{ content, signatures: {} }])
  const signature = signatures?.[signer.address]
  if (!signature) {
    throw new FimsApiError(401, 'wallet did not sign the consent message')
  }
  return getBase64Decoder().decode(signature)
}

export async function fimsSignedFetch<T>(
  apiEndpoint: string,
  signer: MessagePartialSigner,
  method: 'DELETE' | 'PATCH' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const bodyText = body === undefined ? '' : JSON.stringify(body)
  const headers = await fimsAuthHeaders(apiEndpoint, signer, method, `/fims${path}`, bodyText)

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
