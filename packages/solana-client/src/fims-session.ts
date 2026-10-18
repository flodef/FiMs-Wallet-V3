import { getBase64Decoder, type MessagePartialSigner } from '@solana/kit'
import { sameBytes, signContentBytes } from './sign-content.ts'

// ---------------------------------------------------------------------------
// SIWS bearer sessions — one signature per 24h instead of one per request.
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

// Two layers: `sessionCache` deduplicates token resolution (stored or minted)
// and IS dropped on invalidation; `mintCache` deduplicates the actual signing
// round-trip and survives it — otherwise N concurrent 401s on an expired
// stored token would each start their own mint and stack N signature prompts.
const sessionCache = new Map<string, Promise<string>>()
const mintCache = new Map<string, Promise<string>>()
// Generation counter per session key: revoke bumps it, an in-flight mint
// compares before persisting — a token minted across a revoke dies unused.
const mintEpoch = new Map<string, number>()

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
      // Reuse a stored token until the server actually rejects it: the API
      // applies sliding renewal server-side, so the stored expiresAt is stale
      // and gating on it would force a fresh signature ~23h after mint anyway.
      // Expired/unknown tokens get a transparent re-sign on the 401 retry.
      if (stored?.token) return stored.token
    } catch {
      // corrupted or unavailable storage — mint a fresh session
    }
    let minting = mintCache.get(key)
    if (!minting) {
      minting = mintSession(apiEndpoint, signer, storedKey, key).finally(() => mintCache.delete(key))
      mintCache.set(key, minting)
    }
    return minting
  })().finally(() => sessionCache.delete(key))
  sessionCache.set(key, promise)
  return promise
}

async function mintSession(
  apiEndpoint: string,
  signer: MessagePartialSigner,
  storedKey: string,
  key: string,
): Promise<string> {
  const epoch = mintEpoch.get(key) ?? 0
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
  if ((mintEpoch.get(key) ?? 0) !== epoch) {
    // The session was revoked while this mint was in flight — kill the fresh
    // token server-side instead of persisting a bearer nobody wanted.
    try {
      await fetch(`${apiEndpoint.replace(/\/+$/, '')}/fims/session`, {
        headers: { authorization: `Bearer ${token}` },
        method: 'DELETE',
      })
    } catch {
      // offline — the orphan token dies with its TTL anyway
    }
    throw new SessionAuthError(401, 'session revoked')
  }
  try {
    localStorage.setItem(storedKey, JSON.stringify({ expiresAt, token }))
  } catch {
    // storage unavailable — the in-memory cache still covers this page
  }
  return token
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
  // An in-flight mint could resolve AFTER the drop and write a fresh token —
  // bump the epoch so its persist step self-revokes, and stop deduplicating
  // it (401 invalidation keeps mintCache: that is what shares the re-sign).
  const key = `${apiEndpoint}|${address}`
  mintEpoch.set(key, (mintEpoch.get(key) ?? 0) + 1)
  mintCache.delete(key)
  const storedKey = `fims.session|${key}`
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
  mintCache.clear()
  try {
    const keys = Object.keys(localStorage).filter((key) => key.startsWith('fims.session|'))
    for (const key of keys) {
      localStorage.removeItem(key)
    }
  } catch {
    // storage unavailable
  }
}
