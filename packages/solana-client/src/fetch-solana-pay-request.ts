import type { Address } from '@solana/kit'

// Solana Pay transaction-request resolution (https://docs.solanapay.com/spec):
//   GET  <link>              -> { label, icon }  merchant display info
//   POST <link> {account}    -> { transaction: base64, message? }
// The returned transaction is a compiled wire transaction the wallet signs
// and submits — it is NOT a transfer link.
export interface SolanaPayMerchantInfo {
  icon?: string | undefined
  label?: string | undefined
}

export interface SolanaPayRequestResolution {
  merchant: SolanaPayMerchantInfo
  message?: string | undefined
  // Base64 wire transaction to inspect, sign and send.
  transaction: string
}

const TIMEOUT_MS = 10_000

export async function fetchSolanaPayRequest(link: string, account: Address): Promise<SolanaPayRequestResolution> {
  if (!link.startsWith('https://')) {
    throw new Error('Payment request link must be an https URL')
  }

  // The GET is best-effort: several merchants only implement the POST.
  const merchant: SolanaPayMerchantInfo = await fetch(link, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    .then(async (response) => (response.ok ? ((await response.json()) as SolanaPayMerchantInfo) : {}))
    .catch(() => ({}))

  const response = await fetch(link, {
    body: JSON.stringify({ account }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`Payment request failed: HTTP ${response.status}`)
  }
  const body = (await response.json()) as { message?: unknown; transaction?: unknown }
  if (typeof body?.transaction !== 'string' || !body.transaction.length) {
    throw new Error('Payment request returned no transaction')
  }
  return {
    merchant,
    ...(typeof body.message === 'string' ? { message: body.message } : {}),
    transaction: body.transaction,
  }
}
