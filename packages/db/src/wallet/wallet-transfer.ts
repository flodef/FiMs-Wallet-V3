import { z } from 'zod'

import { solanaAddressSchema } from '../solana/solana-address-schema.ts'

// Device-to-device wallet transfer (Jupiter Sync style): the payload is
// encoded into a QR code on the source device and scanned on the target.
// Nothing transits through a server — the payload literally carries the
// secrets, so it must be treated like a recovery phrase.
export const WALLET_TRANSFER_KIND = 'fims-wallet-transfer'
export const WALLET_TRANSFER_VERSION = 1

export const walletTransferAccountSchema = z.object({
  derivationIndex: z.number().default(0),
  name: z.string().trim().min(1).max(20),
  publicKey: solanaAddressSchema,
  // Derived accounts can be restored from the mnemonic; imported ones
  // cannot — their secret key must travel in the payload.
  secretKey: z.string().optional(),
  type: z.enum(['Derived', 'Imported']),
})

export const walletTransferPayloadSchema = z.object({
  accounts: z.array(walletTransferAccountSchema).max(50),
  derivationPath: z.string(),
  kind: z.literal(WALLET_TRANSFER_KIND),
  // Empty for wallets that were imported from a private key (no seed).
  mnemonic: z.string(),
  name: z.string().trim().min(1).max(20),
  v: z.literal(WALLET_TRANSFER_VERSION),
})

export type WalletTransferPayload = z.infer<typeof walletTransferPayloadSchema>

// base64url keeps the QR payload ASCII-safe and paste-friendly (the same
// string doubles as the manual fallback when the camera is unavailable).
const bytesToBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

const base64UrlToBytes = (b64: string) => {
  const padded = `${b64.replace(/-/g, '+').replace(/_/g, '/')}${'='.repeat((4 - (b64.length % 4)) % 4)}`
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))
}

export function walletTransferEncode(payload: WalletTransferPayload): string {
  const parsed = walletTransferPayloadSchema.parse(payload)
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(parsed)))
}

export function walletTransferDecode(raw: string): WalletTransferPayload {
  const trimmed = raw.trim()
  if (!trimmed.length) {
    throw new Error('Empty transfer code')
  }
  const json = new TextDecoder().decode(base64UrlToBytes(trimmed))
  return walletTransferPayloadSchema.parse(JSON.parse(json))
}
