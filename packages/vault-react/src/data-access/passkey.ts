import { decryptWithVaultKey, encryptWithVaultKey } from '@workspace/vault/encrypted-value'

// Biometric unlock via WebAuthn + the hmac-secret PRF extension: the
// authenticator derives a 32-byte secret that wraps the vault key material,
// so the vault unlocks after a fingerprint/Windows Hello assertion instead of
// a password. Requires a platform authenticator that supports PRF (Chrome,
// Edge, Safari on modern OS); enrollment fails loudly when it does not.

export interface VaultPasskeyBlob {
  credentialId: string
  salt: string
  // EncryptedValue JSON — vault key material wrapped under the PRF-derived key.
  wrapped: string
}

export async function isPasskeyAvailable(): Promise<boolean> {
  try {
    return (
      typeof PublicKeyCredential !== 'undefined' &&
      (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable())
    )
  } catch {
    return false
  }
}

export function hasPasskey(stored: string | null | undefined): boolean {
  if (!stored) {
    return false
  }
  try {
    const blob = JSON.parse(stored) as Partial<VaultPasskeyBlob>
    return Boolean(blob.credentialId && blob.salt && blob.wrapped)
  } catch {
    return false
  }
}

export async function enrollPasskey({
  keyMaterial,
  rpName = 'FiMs Wallet',
  userName = 'vault',
}: {
  keyMaterial: string
  rpName?: string
  userName?: string
}): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(32))
  const credential = (await navigator.credentials.create({
    publicKey: {
      attestation: 'none',
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        residentKey: 'required',
        userVerification: 'required',
      },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      extensions: { prf: { eval: { first: salt } } } as unknown as AuthenticationExtensionsClientInputs,
      pubKeyCredParams: [
        { alg: -7, type: 'public-key' },
        { alg: -257, type: 'public-key' },
      ],
      rp: { name: rpName },
      timeout: 60_000,
      user: {
        displayName: userName,
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: userName,
      },
    },
  })) as PublicKeyCredential | null
  if (!credential) {
    throw new Error('Passkey enrollment was cancelled')
  }
  const prfBytes = extractPrf(credential)
  if (!prfBytes) {
    throw new Error('This authenticator does not support the PRF extension — biometric unlock is unavailable')
  }
  const wrapKey = await crypto.subtle.importKey('raw', prfBytes, { name: 'AES-GCM' }, false, ['decrypt', 'encrypt'])
  const blob: VaultPasskeyBlob = {
    credentialId: encodeBase64Url(new Uint8Array(credential.rawId)),
    salt: encodeBase64Url(salt),
    wrapped: await encryptWithVaultKey({ key: wrapKey, value: keyMaterial }),
  }
  return JSON.stringify(blob)
}

export async function unlockVaultWithPasskey(stored: string): Promise<string> {
  const blob = JSON.parse(stored) as VaultPasskeyBlob
  const salt = decodeBase64Url(blob.salt)
  const assertion = (await navigator.credentials.get({
    publicKey: {
      allowCredentials: [
        { id: decodeBase64Url(blob.credentialId) as BufferSource, transports: ['internal'], type: 'public-key' },
      ],
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      extensions: { prf: { eval: { first: salt } } } as unknown as AuthenticationExtensionsClientInputs,
      userVerification: 'required',
    },
  })) as PublicKeyCredential | null
  if (!assertion) {
    throw new Error('Passkey assertion was cancelled')
  }
  const prfBytes = extractPrf(assertion)
  if (!prfBytes) {
    throw new Error('This authenticator did not return a PRF secret')
  }
  const wrapKey = await crypto.subtle.importKey('raw', prfBytes, { name: 'AES-GCM' }, false, ['decrypt', 'encrypt'])
  return await decryptWithVaultKey({ encrypted: blob.wrapped, key: wrapKey })
}

function extractPrf(credential: PublicKeyCredential): ArrayBuffer | undefined {
  const results = credential.getClientExtensionResults() as {
    prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } }
  }
  return results.prf?.results?.first
}

function encodeBase64Url(value: Uint8Array): string {
  const binary = Array.from(value, (byte) => String.fromCharCode(byte)).join('')
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}
