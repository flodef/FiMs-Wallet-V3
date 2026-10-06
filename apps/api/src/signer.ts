// Pluggable server-side signers via @solana/keychain.
//
// Two hot keys exist in this API: CUSTODIAL_KEYPAIR (mint authority + custody
// wallet, see custodial.ts) and STRATEGY_DELEGATE_KEYPAIR (whitelisted CPI
// delegate, see strategy-delegate.ts). Today both are raw 64-byte secrets in
// env vars. The keychain signer abstraction lets either move to a real KMS —
// the key then never leaves the HSM — by flipping env vars, no code change.
//
// Backend selection, per key (PREFIX = CUSTODIAL or STRATEGY_DELEGATE):
//   ${PREFIX}_SIGNER_BACKEND = "memory" | "gcp_kms"     (default "memory")
//
//   memory  : ${PREFIX}_KEYPAIR — 64-byte secret, "[1,2,...]" JSON or base58
//             (status quo; the byte decode stays in the caller for error text)
//   gcp_kms : ${PREFIX}_GCP_KMS_KEY_NAME  — full cryptoKeyVersion resource name
//             ${PREFIX}_GCP_KMS_PUBLIC_KEY — base58 Solana pubkey of that key
//             + GCP credentials: either GOOGLE_APPLICATION_CREDENTIALS already
//               pointing at a service-account file, or GCP_SA_KEY_JSON holding
//               the service-account JSON itself (written to /tmp — google's
//               ADC only reads credential files, never inline JSON).
//
// The returned object is a Kit TransactionSigner: a keychain
// SolanaTransactionSigner extends TransactionPartialSigner, so it drops
// straight into setTransactionMessageFeePayerSigner +
// signTransactionMessageWithSigners without an adapter.

import type { SolanaTransactionSigner } from '@solana/keychain-core'
import type { TransactionSigner } from '@solana/kit'

export type SignerEnvPrefix = 'CUSTODIAL' | 'STRATEGY_DELEGATE'

const BACKENDS = ['memory', 'gcp_kms'] as const
export type SignerBackend = (typeof BACKENDS)[number]

export function signerBackend(prefix: SignerEnvPrefix): SignerBackend {
  const raw = process.env[`${prefix}_SIGNER_BACKEND`] ?? 'memory'
  for (const backend of BACKENDS) {
    if (raw === backend) return backend
  }
  throw new Error(`${prefix}_SIGNER_BACKEND must be one of ${BACKENDS.join(', ')} (got "${raw}")`)
}

// Build the backend-selected signer. `memorySecretKey` is only invoked for
// the memory backend so a KMS deployment needs no *_KEYPAIR at all: callers
// keep owning the legacy decode (JSON array / base58, 64 bytes) and its error
// text, which custodial.spec.ts and the ops runbook reference.
export async function createBackendSigner(
  prefix: SignerEnvPrefix,
  memorySecretKey: () => Uint8Array,
): Promise<TransactionSigner & SolanaTransactionSigner> {
  const backend = signerBackend(prefix)
  if (backend === 'memory') {
    const { createMemorySignerFromBytes } = await import('@solana/keychain-memory')
    return await createMemorySignerFromBytes(memorySecretKey())
  }
  if (backend === 'gcp_kms') {
    const keyName = process.env[`${prefix}_GCP_KMS_KEY_NAME`]
    const publicKey = process.env[`${prefix}_GCP_KMS_PUBLIC_KEY`]
    if (!keyName || !publicKey) {
      throw new Error(
        `${prefix}_GCP_KMS_KEY_NAME and ${prefix}_GCP_KMS_PUBLIC_KEY are required for the gcp_kms backend`,
      )
    }
    await provisionAdcFile()
    // Dynamic import keeps google-auth-library out of the cold path — a
    // memory-backend deployment never loads it.
    const { createGcpKmsSigner } = await import('@solana/keychain-gcp-kms')
    return createGcpKmsSigner({ keyName, publicKey })
  }
  // Unreachable: signerBackend() rejects unknown values first.
  throw new Error(`unhandled signer backend: ${backend}`)
}

// Application Default Credentials only read a credential FILE — on Vercel the
// service-account JSON lives in an env var, so materialize it once per warm
// instance. Skipped entirely when GOOGLE_APPLICATION_CREDENTIALS is already
// set (local gcloud auth, CI, a mounted file).
const ADC_PATH = '/tmp/fims-gcp-sa.json'
async function provisionAdcFile(): Promise<void> {
  if (process.env['GOOGLE_APPLICATION_CREDENTIALS']) return
  const json = process.env['GCP_SA_KEY_JSON']
  if (!json) {
    throw new Error(
      'gcp_kms backend needs credentials: set GCP_SA_KEY_JSON (service-account JSON) ' +
        'or GOOGLE_APPLICATION_CREDENTIALS (path to a key file)',
    )
  }
  // Mode 0600 — the file holds a credential, not key material, but keep it
  // owner-only anyway; the JSON itself stays a Vercel secret.
  const { writeFile } = await import('node:fs/promises')
  await writeFile(ADC_PATH, json, { mode: 0o600 })
  process.env['GOOGLE_APPLICATION_CREDENTIALS'] = ADC_PATH
}
