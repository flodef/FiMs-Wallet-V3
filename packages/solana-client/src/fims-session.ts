import { getBase64Decoder, type MessagePartialSigner } from '@solana/kit'
import { sameBytes, signContentBytes } from './sign-content.ts'

// ---------------------------------------------------------------------------
// SIWS bearer sessions — one signature per week instead of one per request.
// The message text is rebuilt byte-identically by the server (only the four
// fields below travel over the wire). Shared by every API client (member and
// chain reads) so a single wallet prompt covers all of them.
// ---------------------------------------------------------------------------
export function fimsSessionMessage(host: string, address: string, nonce: string, issuedAt: string): string {
  return (
    `${host} wants you to sign in with your Solana account:\n` +
    `${address}\n\n` +
    'Signs you in to the FiMs API for 24 hours. This does not authorize transactions.\n\n' +
    `URI: ${host}\n` +
    'Version: 1\n' +
    'Chain ID: solana\n' +
    `Nonce: ${nonce}\n` +
    `Issued At: ${issuedAt}`
  )
}

export class SessionAuthError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'SessionAuthError'
    this.status = status
  }
}

const sessionCache = new Map<string, Promise<string>>()

export async function fimsSessionToken(apiEndpoint: string, signer: MessagePartialSigner): Promise<string> {
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
    const { signature, signedMessage } = await signContentBytes(signer, content)
    const res = await fetch(`${apiEndpoint.replace(/\/+$/, '')}/fims/session`, {
      body: JSON.stringify({
        address: signer.address,
        issuedAt,
        nonce,
        signature: getBase64Decoder().decode(signature),
        signedMessage: sameBytes(signedMessage, content) ? undefined : getBase64Decoder().decode(signedMessage),
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    if (!res.ok) {
      const text = await res.text()
      throw new SessionAuthError(res.status, text.slice(0, 200))
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

export function fimsInvalidateSession(apiEndpoint: string, signer: MessagePartialSigner): void {
  fimsDropSession(apiEndpoint, signer.address)
}

function fimsDropSession(apiEndpoint: string, address: string): void {
  const key = `${apiEndpoint}|${address}`
  sessionCache.delete(key)
  try {
    localStorage.removeItem(`fims.session|${key}`)
  } catch {
    // storage unavailable
  }
}

// Explicit disconnect/reset path: revoke the bearer token server-side (best
// effort — a dead API must not block the local unlink), then drop it locally.
export async function fimsRevokeSession(apiEndpoint: string, address: string): Promise<void> {
  const storedKey = `fims.session|${apiEndpoint}|${address}`
  let token: null | string = null
  try {
    token = (JSON.parse(localStorage.getItem(storedKey) ?? 'null') as null | { token: string })?.token ?? null
  } catch {
    // corrupted or unavailable storage — nothing to revoke remotely
  }
  fimsDropSession(apiEndpoint, address)
  if (!token) return
  try {
    await fetch(`${apiEndpoint.replace(/\/+$/, '')}/fims/session`, {
      headers: { authorization: `Bearer ${token}` },
      method: 'DELETE',
    })
  } catch {
    // offline or API down — the token dies with its TTL anyway
  }
}

// Wipe every stored bearer session — the database reset path must not leave
// valid tokens behind for accounts that no longer exist locally.
export function fimsClearAllSessions(): void {
  sessionCache.clear()
  try {
    const keys = Object.keys(localStorage).filter((key) => key.startsWith('fims.session|'))
    for (const key of keys) {
      localStorage.removeItem(key)
    }
  } catch {
    // storage unavailable
  }
}
