import { type Address, assertIsAddress } from '@solana/kit'

// Solana Pay URL parsing (https://docs.solanapay.com/spec):
//   solana:<recipient>?amount=1.5&spl-token=<mint>&reference=<key>&label=..&message=..&memo=..
// The recipient field may instead be a URL-encoded https link — a
// "transaction request" the wallet must fetch to get the transaction to sign.
export interface SolanaPayTransferRequest {
  amount?: string
  kind: 'transfer'
  label?: string
  memo?: string
  message?: string
  recipient: Address
  references: Address[]
  splToken?: Address
}

export interface SolanaPayLinkRequest {
  kind: 'link'
  url: string
}

export type SolanaPayRequest = SolanaPayLinkRequest | SolanaPayTransferRequest

const SCHEME = 'solana'
// Spec: amounts are decimal, non-negative, no exponent or other notation.
const AMOUNT_PATTERN = /^\d*\.?\d+$/

export function parseSolanaPayUrl(raw: string): SolanaPayRequest {
  const trimmed = raw.trim()
  if (!trimmed.length) {
    throw new Error('Empty payment link')
  }
  const url = new URL(trimmed)
  if (url.protocol !== `${SCHEME}:`) {
    throw new Error(`Unsupported payment link scheme: ${url.protocol}`)
  }

  const recipientPart = decodeURIComponent(url.pathname)
  if (!recipientPart.length) {
    throw new Error('Payment link is missing a recipient')
  }

  // Transaction-request link: fetch the URL to resolve the transaction.
  if (recipientPart.startsWith('http://') || recipientPart.startsWith('https://')) {
    return { kind: 'link', url: recipientPart }
  }

  assertIsAddress(recipientPart)
  const request: SolanaPayTransferRequest = {
    kind: 'transfer',
    recipient: recipientPart,
    references: [],
  }

  for (const [key, value] of url.searchParams.entries()) {
    switch (key) {
      case 'amount': {
        if (!AMOUNT_PATTERN.test(value) || Number(value) === 0) {
          throw new Error(`Invalid payment amount: ${value}`)
        }
        request.amount = value
        break
      }
      case 'spl-token': {
        assertIsAddress(value)
        request.splToken = value
        break
      }
      case 'reference': {
        assertIsAddress(value)
        request.references.push(value)
        break
      }
      case 'label': {
        request.label = value
        break
      }
      case 'message': {
        request.message = value
        break
      }
      case 'memo': {
        request.memo = value
        break
      }
      default:
        break
    }
  }
  return request
}
