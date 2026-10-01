import { getBase64Decoder, type KeyPairSigner } from '@solana/kit'

// Types mirror the Effect schemas in apps/api/src/routes/fims/api.ts
export interface FimsUser {
  address: string
  createdAt: string
  id: number
  isPro: boolean
  isPublic: boolean
  name: string
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

// Mutations are authenticated by a wallet signature, verified by the API:
// the signer signs `fims-wallet-v3\n{METHOD}\n{PATHNAME}\n{TIMESTAMP_MS}`.
export async function fimsSignedFetch<T>(
  apiEndpoint: string,
  signer: KeyPairSigner,
  method: 'DELETE' | 'PATCH' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const ts = Date.now()
  const content = new TextEncoder().encode(`fims-wallet-v3\n${method}\n/fims${path}\n${ts}`)
  const [signatures] = await signer.signMessages([{ content, signatures: {} }])
  const signature = signatures?.[signer.address]
  if (!signature) {
    throw new FimsApiError(401, 'wallet did not sign the request')
  }

  const url = `${apiEndpoint.replace(/\/+$/, '')}/fims${path}`
  const res = await fetch(url, {
    body: body === undefined ? null : JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      'x-fims-address': signer.address,
      'x-fims-sig': getBase64Decoder().decode(signature),
      'x-fims-ts': String(ts),
    },
    method,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new FimsApiError(res.status, text.slice(0, 200))
  }
  return (await res.json()) as T
}
