import type { HttpServerRequest } from '@effect/platform'
import { ed25519 } from '@noble/curves/ed25519'
import { getBase58Decoder } from '@solana/codecs-strings'
import { Effect, Layer } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DatabaseService } from '../../db/service.ts'
import {
  canonicalizeQuery,
  createSession,
  deleteSession,
  fimsSessionMessage,
  verifyAddressSignature,
  verifyFreshConfirmation,
  verifyWalletRequest,
} from './service.ts'

const privateKey = ed25519.utils.randomPrivateKey()
const address = getBase58Decoder().decode(ed25519.getPublicKey(privateKey))
const HOST = 'api.fims.test'

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// In-memory stand-in for the used_signatures table: the first insert of a
// signature returns a row, every subsequent one returns an empty conflict.
// Also fakes fims_sessions (tokenHash → row) for the bearer-session paths.
function makeReplayAwareDb() {
  const used = new Set<string>()
  const sessions = new Map<string, { address: string; expiresAt: Date; lastSeenAt?: Date; tokenHash: string }>()
  // Extract the plain value from a drizzle `eq(column, value)` condition.
  const condValue = (cond: unknown) => {
    const chunks = (cond as { queryChunks?: { value?: unknown }[] }).queryChunks ?? []
    const hit = chunks.find((c) => typeof c?.value === 'string')
    return hit?.value as string | undefined
  }
  return {
    delete: () => ({
      where: async (cond: unknown) => {
        sessions.delete(condValue(cond) ?? '')
        return []
      },
    }),
    execute: async () => ({ rows: [] }),
    insert: () => ({
      values: (row: { signature?: string; tokenHash?: string }) => {
        const apply = () => {
          if (row.tokenHash) sessions.set(row.tokenHash, row as never)
          return [row]
        }
        return {
          onConflictDoNothing: () => ({
            returning: async () => {
              if (row.signature) {
                if (used.has(row.signature)) return []
                used.add(row.signature)
              }
              return apply()
            },
          }),
          // biome-ignore lint/suspicious/noThenProperty: intentional thenable — mimics drizzle's awaitable insert
          then: (resolve: (v: unknown) => unknown) => Promise.resolve(apply()).then(resolve),
        }
      },
    }),
    select: () => ({
      from: () => ({
        where: (cond: unknown) => ({
          limit: async () => {
            const row = sessions.get(condValue(cond) ?? '')
            return row ? [row] : []
          },
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: async () => [],
      }),
    }),
  }
}

const testDb = (db = makeReplayAwareDb()) => Layer.succeed(DatabaseService, DatabaseService.make({ db: db as never }))

const run = <A, E>(effect: Effect.Effect<A, E, DatabaseService>, db?: ReturnType<typeof makeReplayAwareDb>) =>
  Effect.runPromise(effect.pipe(Effect.provide(testDb(db))))

// Builds the signed request exactly like the client does
// (packages/feature-fims/src/fims-api.ts): the signed resource is the pathname
// plus its canonical query.
async function signedRequest({
  body = '',
  method = 'GET',
  signedResource,
  ts = Date.now(),
  url,
}: {
  body?: string
  method?: string
  signedResource?: string
  ts?: number
  url: string
}): Promise<HttpServerRequest.HttpServerRequest> {
  const parsed = new URL(url)
  const query = canonicalizeQuery(parsed.searchParams)
  const resource = signedResource ?? (query ? `${parsed.pathname}?${query}` : parsed.pathname)
  const message = `fims-wallet-v3\n${HOST}\n${method}\n${resource}\n${ts}\n${await sha256Hex(body)}`
  const signature = ed25519.sign(new TextEncoder().encode(message), privateKey)
  return {
    headers: {
      host: HOST,
      'x-fims-address': address,
      'x-fims-sig': btoa(String.fromCharCode(...signature)),
      'x-fims-ts': String(ts),
    },
    method,
    text: Effect.succeed(body),
    url,
  } as unknown as HttpServerRequest.HttpServerRequest
}

describe('canonicalize-query', () => {
  describe('expected behavior', () => {
    it('should serialize an empty query to an empty string', () => {
      // ARRANGE
      expect.assertions(1)
      const params = new URLSearchParams('')

      // ACT
      const result = canonicalizeQuery(params)

      // ASSERT
      expect(result).toBe('')
    })

    it('should sort pairs by key then value', () => {
      // ARRANGE
      expect.assertions(1)
      const params = new URLSearchParams('b=2&a=1&a=0')

      // ACT
      const result = canonicalizeQuery(params)

      // ASSERT
      expect(result).toBe('a=0&a=1&b=2')
    })

    it('should produce the same canonical form for reordered input', () => {
      // ARRANGE
      expect.assertions(1)

      // ACT
      const result = canonicalizeQuery(new URLSearchParams('offset=0&limit=2000'))
      const result2 = canonicalizeQuery(new URLSearchParams('limit=2000&offset=0'))

      // ASSERT
      expect(result).toBe(result2)
    })
  })
})

describe('verify-wallet-request', () => {
  describe('expected behavior', () => {
    it('should return the signer address for a valid request without query', async () => {
      // ARRANGE
      expect.assertions(1)
      const request = await signedRequest({ url: `https://${HOST}/fims/votes` })

      // ACT
      const result = await run(verifyWalletRequest(request))

      // ASSERT
      expect(result).toBe(address)
    })

    it('should return the signer address for a valid request with canonical query', async () => {
      // ARRANGE
      expect.assertions(1)
      const request = await signedRequest({ url: `https://${HOST}/fims/users?limit=2000&offset=0` })

      // ACT
      const result = await run(verifyWalletRequest(request))

      // ASSERT
      expect(result).toBe(address)
    })

    it('should verify a signature when query parameters arrive in a different order', async () => {
      // ARRANGE
      expect.assertions(1)
      const request = await signedRequest({ url: `https://${HOST}/fims/users?offset=0&limit=2000` })

      // ACT
      const result = await run(verifyWalletRequest(request))

      // ASSERT
      expect(result).toBe(address)
    })

    it('should accept a mutation once per signature', async () => {
      // ARRANGE
      expect.assertions(1)
      const request = await signedRequest({ body: '{}', method: 'POST', url: `https://${HOST}/fims/conversions` })

      // ACT
      const result = await run(verifyWalletRequest(request))

      // ASSERT
      expect(result).toBe(address)
    })
  })

  describe('unexpected behavior', () => {
    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('should reject a signed request replayed with swapped query parameters', async () => {
      // ARRANGE
      expect.assertions(1)
      // Signed for limit=2000, replayed against limit=1.
      const request = await signedRequest({
        signedResource: '/fims/users?limit=2000&offset=0',
        url: `https://${HOST}/fims/users?limit=1&offset=0`,
      })

      // ACT & ASSERT
      await expect(run(verifyWalletRequest(request))).rejects.toThrow()
    })

    it('should reject a signature that omits the query binding', async () => {
      // ARRANGE
      expect.assertions(1)
      // The removed legacy mode signed only the pathname — a captured signature
      // was replayable with arbitrary query parameters, so it must fail now.
      const url = `https://${HOST}/fims/users?limit=2000&offset=0`
      const request = await signedRequest({ signedResource: '/fims/users', url })

      // ACT & ASSERT
      await expect(run(verifyWalletRequest(request))).rejects.toThrow()
    })

    it('should reject the same mutation signature when replayed', async () => {
      // ARRANGE
      expect.assertions(1)
      const db = makeReplayAwareDb()
      const request = await signedRequest({ body: '{}', method: 'POST', url: `https://${HOST}/fims/conversions` })
      await run(verifyWalletRequest(request), db)

      // ACT & ASSERT — the second use of the exact same signature burns out
      await expect(run(verifyWalletRequest(request), db)).rejects.toThrow()
    })

    it('should reject a request with a stale timestamp', async () => {
      // ARRANGE
      expect.assertions(1)
      const request = await signedRequest({
        ts: Date.now() - 10 * 60 * 1000,
        url: `https://${HOST}/fims/votes`,
      })

      // ACT & ASSERT
      await expect(run(verifyWalletRequest(request))).rejects.toThrow()
    })

    it('should reject a request with a malformed address header', async () => {
      // ARRANGE
      expect.assertions(1)
      const request = await signedRequest({ url: `https://${HOST}/fims/votes` })
      ;(request.headers as Record<string, string>)['x-fims-address'] = 'not-base58!!'

      // ACT & ASSERT
      await expect(run(verifyWalletRequest(request))).rejects.toThrow()
    })

    it('should reject a request with missing auth headers', async () => {
      // ARRANGE
      expect.assertions(1)
      const request = {
        headers: { host: HOST },
        method: 'GET',
        text: Effect.succeed(''),
        url: `https://${HOST}/fims/votes`,
      } as unknown as HttpServerRequest.HttpServerRequest

      // ACT & ASSERT
      await expect(run(verifyWalletRequest(request))).rejects.toThrow()
    })
  })
})

// Consent proof for multi-wallet linking: the NEW address signs the canonical
// link message (`fims-wallet-v3\nlink-address\n<userId>\n<address>`) so an
// already-linked signer alone cannot squat a foreign key.
describe('verify-address-signature', () => {
  const linkContent = (userId: number, addr: string) =>
    new TextEncoder().encode(`fims-wallet-v3\nlink-address\n${userId}\n${addr}`)
  const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))

  describe('expected behavior', () => {
    it('should accept a consent signature by the linked address', () => {
      // ARRANGE
      expect.assertions(1)
      const content = linkContent(7, address)
      const signature = ed25519.sign(content, privateKey)

      // ACT
      const result = verifyAddressSignature(address, content, b64(signature))

      // ASSERT
      expect(result).toBe(true)
    })
  })

  describe('unexpected behavior', () => {
    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('should reject a consent signature by a different key', () => {
      // ARRANGE
      expect.assertions(1)
      const otherKey = ed25519.utils.randomPrivateKey()
      const content = linkContent(7, address)
      const signature = ed25519.sign(content, otherKey)

      // ACT
      const result = verifyAddressSignature(address, content, b64(signature))

      // ASSERT
      expect(result).toBe(false)
    })

    it('should reject a consent signature replayed for a different member', () => {
      // ARRANGE
      expect.assertions(1)
      // Signed for member 7 — must not attach the address to member 8.
      const signature = ed25519.sign(linkContent(7, address), privateKey)

      // ACT
      const result = verifyAddressSignature(address, linkContent(8, address), b64(signature))

      // ASSERT
      expect(result).toBe(false)
    })

    it('should reject a malformed consent signature instead of throwing', () => {
      // ARRANGE
      expect.assertions(1)
      const content = linkContent(7, address)

      // ACT
      const result = verifyAddressSignature(address, content, 'not-a-signature!!')

      // ASSERT
      expect(result).toBe(false)
    })
  })
})

// Bearer sessions: POST /fims/session mints a token from ONE SIWS signature;
// subsequent requests authenticate with `Authorization: Bearer` instead of a
// per-request signature. Sensitive actions still demand verifyFreshConfirmation.
describe('fims-sessions', () => {
  const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))

  async function sessionBody() {
    const nonce = 'a1b2c3d4e5f6a7b8'
    const issuedAt = new Date().toISOString()
    const message = fimsSessionMessage(HOST, address, nonce, issuedAt)
    const signature = b64(ed25519.sign(new TextEncoder().encode(message), privateKey))
    return { address, issuedAt, nonce, signature }
  }

  const sessionRequest = (token?: string): HttpServerRequest.HttpServerRequest =>
    ({
      headers: { authorization: token ? `Bearer ${token}` : '', host: HOST },
      method: 'GET',
      text: Effect.succeed(''),
      url: `https://${HOST}/fims/users`,
    }) as unknown as HttpServerRequest.HttpServerRequest

  const createRequest = (): HttpServerRequest.HttpServerRequest =>
    ({
      headers: { host: HOST },
      method: 'POST',
      text: Effect.succeed(''),
      url: `https://${HOST}/fims/session`,
    }) as unknown as HttpServerRequest.HttpServerRequest

  describe('expected behavior', () => {
    it('should mint a session from a valid SIWS signature and resolve the bearer token', async () => {
      // ARRANGE
      expect.assertions(2)
      const db = makeReplayAwareDb()

      // ACT
      const session = await run(createSession(createRequest(), await sessionBody()), db)
      const signer = await run(verifyWalletRequest(sessionRequest(session.token)), db)

      // ASSERT
      expect(session.token).toHaveLength(64)
      expect(signer).toBe(address)
    })

    it('should revoke the session on delete', async () => {
      // ARRANGE
      expect.assertions(1)
      const db = makeReplayAwareDb()
      const session = await run(createSession(createRequest(), await sessionBody()), db)

      // ACT
      const result = await run(deleteSession(sessionRequest(session.token)), db)

      // ASSERT
      expect(result).toBe('session revoked')
    })

    it('should accept a fresh confirmation signature on a sensitive mutation', async () => {
      // ARRANGE
      expect.assertions(1)
      const db = makeReplayAwareDb()
      const ts = Date.now()
      const body = ''
      const bodyHash = await sha256Hex(body)
      const message = `fims-confirm\n${HOST}\nDELETE\n/fims/users/42\n${ts}\n${bodyHash}`
      const request = {
        headers: {
          host: HOST,
          'x-fims-confirm-sig': b64(ed25519.sign(new TextEncoder().encode(message), privateKey)),
          'x-fims-confirm-ts': String(ts),
        },
        method: 'DELETE',
        text: Effect.succeed(body),
        url: `https://${HOST}/fims/users/42`,
      } as unknown as HttpServerRequest.HttpServerRequest

      // ACT & ASSERT
      await expect(run(verifyFreshConfirmation(request, address), db)).resolves.toBeUndefined()
    })
  })

  describe('unexpected behavior', () => {
    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('should reject an unknown bearer token', async () => {
      // ARRANGE
      expect.assertions(1)

      // ACT & ASSERT
      await expect(run(verifyWalletRequest(sessionRequest('deadbeef'.repeat(8))))).rejects.toThrow()
    })

    it('should reject a session mint replay (same SIWS signature twice)', async () => {
      // ARRANGE
      expect.assertions(1)
      const db = makeReplayAwareDb()
      const body = await sessionBody()
      await run(createSession(createRequest(), body), db)

      // ACT & ASSERT
      await expect(run(createSession(createRequest(), body), db)).rejects.toThrow()
    })

    it('should reject a sign-in with a stale issuedAt', async () => {
      // ARRANGE
      expect.assertions(1)
      const body = await sessionBody()
      body.issuedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString()
      // Re-sign over the stale timestamp so only freshness fails.
      body.signature = b64(
        ed25519.sign(
          new TextEncoder().encode(fimsSessionMessage(HOST, address, body.nonce, body.issuedAt)),
          privateKey,
        ),
      )

      // ACT & ASSERT
      await expect(run(createSession(createRequest(), body))).rejects.toThrow()
    })

    it('should reject a confirmation signature replayed', async () => {
      // ARRANGE
      expect.assertions(1)
      const db = makeReplayAwareDb()
      const ts = Date.now()
      const bodyHash = await sha256Hex('')
      const message = `fims-confirm\n${HOST}\nDELETE\n/fims/users/42\n${ts}\n${bodyHash}`
      const request = {
        headers: {
          host: HOST,
          'x-fims-confirm-sig': b64(ed25519.sign(new TextEncoder().encode(message), privateKey)),
          'x-fims-confirm-ts': String(ts),
        },
        method: 'DELETE',
        text: Effect.succeed(''),
        url: `https://${HOST}/fims/users/42`,
      } as unknown as HttpServerRequest.HttpServerRequest
      await run(verifyFreshConfirmation(request, address), db)

      // ACT & ASSERT
      await expect(run(verifyFreshConfirmation(request, address), db)).rejects.toThrow()
    })
  })
})
