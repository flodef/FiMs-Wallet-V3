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
  // Token units as an exact decimal string (numeric column) — convert with
  // Number() where a float is enough; do not serialize back.
  amount: null | string
  cost: number
  createdAt: string
  date: string
  // Token units gifted to donationTarget inside this row (same token as
  // `amount`): a withdrawal/conversion can carry its tontine share inline
  // instead of a separate donation row. Its EUR share is movement ×
  // donationAmount/|amount|. Pure donations keep it null.
  donationAmount: null | string
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

// ---------------------------------------------------------------------------
// SIWS bearer sessions — one signature per week instead of one per request.
// The message text is rebuilt byte-identically by the server (only the four
// fields below travel over the wire).
// ---------------------------------------------------------------------------
function fimsSessionMessage(host: string, address: string, nonce: string, issuedAt: string): string {
  return (
    `${host} wants you to sign in with your Solana account:\n` +
    `${address}\n\n` +
    'Signs you in to the FiMs API for 7 days. This does not authorize transactions.\n\n' +
    `URI: ${host}\n` +
    'Version: 1\n' +
    'Chain ID: solana\n' +
    `Nonce: ${nonce}\n` +
    `Issued At: ${issuedAt}`
  )
}

const sessionCache = new Map<string, Promise<string>>()

async function fimsSessionToken(apiEndpoint: string, signer: MessagePartialSigner): Promise<string> {
  const key = `${apiEndpoint}|${signer.address}`
  const existing = sessionCache.get(key)
  if (existing) return existing
  const promise = (async () => {
    const storedKey = `fims.session|${key}`
    try {
      const stored = JSON.parse(localStorage.getItem(storedKey) ?? 'null') as null | {
        expiresAt: string
        token: string
      }
      // Reuse a stored session while it has an hour of life left.
      if (stored && Date.parse(stored.expiresAt) > Date.now() + 3_600_000) return stored.token
    } catch {
      // corrupted or unavailable storage — mint a fresh session
    }
    const host = new URL(apiEndpoint).host
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    const issuedAt = new Date().toISOString()
    const content = new TextEncoder().encode(fimsSessionMessage(host, signer.address, nonce, issuedAt))
    const signature = await fimsSignMessage(signer, content)
    const res = await fetch(`${apiEndpoint.replace(/\/+$/, '')}/fims/session`, {
      body: JSON.stringify({ address: signer.address, issuedAt, nonce, signature }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    if (!res.ok) {
      const text = await res.text()
      throw new FimsApiError(res.status, text.slice(0, 200))
    }
    const { expiresAt, token } = (await res.json()) as { expiresAt: string; token: string }
    try {
      localStorage.setItem(storedKey, JSON.stringify({ expiresAt, token }))
    } catch {
      // storage unavailable — the in-memory cache still covers this page
    }
    return token
  })().finally(() => sessionCache.delete(key))
  sessionCache.set(key, promise)
  return promise
}

function fimsInvalidateSession(apiEndpoint: string, signer: MessagePartialSigner): void {
  const key = `${apiEndpoint}|${signer.address}`
  sessionCache.delete(key)
  try {
    localStorage.removeItem(`fims.session|${key}`)
  } catch {
    // storage unavailable
  }
}

// Destructive/identity mutations require a fresh confirmation signature on
// top of the session — a stolen token alone cannot delete or hijack a member.
const CONFIRMED_RESOURCE = /^\/fims\/users\/\d+(?:\/addresses(?:\/[^/?]+)?)?$/
const needsConfirmation = (method: string, resource: string) =>
  CONFIRMED_RESOURCE.test(resource) && (method === 'DELETE' || method === 'POST')

async function fimsAuthHeaders(
  apiEndpoint: string,
  signer: MessagePartialSigner,
  method: 'DELETE' | 'GET' | 'PATCH' | 'POST',
  resource: string,
  bodyText: string,
): Promise<Record<string, string>> {
  const token = await fimsSessionToken(apiEndpoint, signer)
  const headers: Record<string, string> = { authorization: `Bearer ${token}` }
  if (needsConfirmation(method, resource)) {
    const ts = Date.now()
    const host = new URL(apiEndpoint).host
    const bodyHash = await sha256Hex(bodyText)
    const content = new TextEncoder().encode(`fims-confirm\n${host}\n${method}\n${resource}\n${ts}\n${bodyHash}`)
    headers['x-fims-confirm-sig'] = await fimsSignMessage(signer, content)
    headers['x-fims-confirm-ts'] = String(ts)
  }
  return headers
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
  const headers = await fimsAuthHeaders(
    apiEndpoint,
    signer,
    'GET',
    canonicalResource(`/fims${path}`, url.searchParams),
    '',
  )
  let res = await fetch(url, { headers })
  if (res.status === 401) {
    // The server may have dropped the session (restart, purge) — re-sign in
    // once, transparently.
    fimsInvalidateSession(apiEndpoint, signer)
    const retryHeaders = await fimsAuthHeaders(
      apiEndpoint,
      signer,
      'GET',
      canonicalResource(`/fims${path}`, url.searchParams),
      '',
    )
    res = await fetch(url, { headers: retryHeaders })
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
  let res = await fetch(url, {
    body: body === undefined ? null : bodyText,
    headers: { 'content-type': 'application/json', ...headers },
    method,
  })
  if (res.status === 401) {
    fimsInvalidateSession(apiEndpoint, signer)
    const retryHeaders = await fimsAuthHeaders(apiEndpoint, signer, method, `/fims${path}`, bodyText)
    res = await fetch(url, {
      body: body === undefined ? null : bodyText,
      headers: { 'content-type': 'application/json', ...retryHeaders },
      method,
    })
  }
  if (!res.ok) {
    const text = await res.text()
    throw new FimsApiError(res.status, text.slice(0, 200))
  }
  return (await res.json()) as T
}
