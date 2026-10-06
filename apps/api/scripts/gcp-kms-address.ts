// Derive the Solana address of a Cloud KMS cryptoKeyVersion public key.
//
//   bun run scripts/gcp-kms-address.ts path/to/public.pem
//
// Used by gcp-kms-provision.sh to verify a provisioned KMS key derives to the
// expected custodial address before flipping CUSTODIAL_SIGNER_BACKEND.
import { readFileSync } from 'node:fs'

import { addressFromSpkiPem } from '@solana/keychain-core'

const pemPath = process.argv[2]
if (!pemPath) {
  console.error('usage: bun run scripts/gcp-kms-address.ts <public-key.pem>')
  process.exit(1)
}
const solanaAddress = addressFromSpkiPem(readFileSync(pemPath, 'utf8'))
if (!solanaAddress) {
  console.error('could not derive a Solana address from that PEM (expected Ed25519 SPKI)')
  process.exit(1)
}
console.log(solanaAddress)
