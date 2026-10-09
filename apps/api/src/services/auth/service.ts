// cspell:ignore replayable pubkeys
import { Headers, type HttpServerRequest } from '@effect/platform'
import { ed25519 } from '@noble/curves/ed25519'
import { getBase58Encoder } from '@solana/codecs-strings'
import { eq, sql } from 'drizzle-orm'
import { Effect, Option, Schema } from 'effect'
import { fimsSessions, usedSignatures } from '../../db/schema.js'
import { DatabaseError, DatabaseService } from '../../db/service.js'
import { FIMS_DEMO_ADDRESS } from '../../fims-constants.js'

export class AuthUnauthorized extends Schema.TaggedError<AuthUnauthorized>()('AuthUnauthorized', {
  reason: Schema.String,
}) {}

export class AuthForbidden extends Schema.TaggedError<AuthForbidden>()('AuthForbidden', {
  address: Schema.String,
}) {}

// 5 min window — a signed request is replayable only within it, and only
// for the same host+method+path+query+body (all are part of the signed message).
const MAX_SKEW_MS = 5 * 60 * 1000

const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
const header = (request: HttpServerRequest.HttpServerRequest, name: string) =>
  Option.getOrElse(Headers.get(request.headers, name), () => '')

const sha256Hex = (text: string) =>
  Effect.promise(async () =>
    Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(''),
  )

const sha256HexBytes = async (data: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

// Canonical query serialization, signed along with the path. The client runs
// the identical algorithm (packages/feature-fims/src/fims-canonical-query.ts):
// decode each pair, sort by key then value, re-encode with URLSearchParams
// (form-urlencoded). Sorting makes `?a=1&b=2` and `?b=2&a=1` sign identically.
export function canonicalizeQuery(searchParams: URLSearchParams): string {
  const pairs = [...searchParams.entries()]
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1))
  return new URLSearchParams(pairs).toString()
}

/**
 * Bearer-session auth: `Authorization: Bearer <token>` resolves to the
 * session's wallet address. Only the token hash is stored server-side, so
 * a forged or database-leaked token is useless; expiry is enforced here.
 */
function verifyBearerSession(request: HttpServerRequest.HttpServerRequest) {
  return Effect.gen(function* () {
    const token = header(request, 'authorization').slice('Bearer '.length)
    const tokenHash = yield* Effect.tryPromise({
      catch: () => new AuthUnauthorized({ reason: 'malformed session token' }),
      try: () => sha256HexBytes(new TextEncoder().encode(token)),
    })
    const { db } = yield* DatabaseService
    const rows = yield* Effect.tryPromise({
      catch: (cause) => new DatabaseError({ cause }),
      try: () => db.select().from(fimsSessions).where(eq(fimsSessions.tokenHash, tokenHash)).limit(1),
    })
    const row = rows[0]
    if (!row) return yield* Effect.fail(new AuthUnauthorized({ reason: 'unknown session token' }))
    if (row.expiresAt.getTime() < Date.now())
      return yield* Effect.fail(new AuthUnauthorized({ reason: 'session expired' }))
    // Opportunistic touch — last_seen feeds session monitoring.
    if (Math.random() < 0.05) {
      yield* Effect.tryPromise({
        catch: () => new DatabaseError({ cause: 'session touch failed' }),
        try: () => db.update(fimsSessions).set({ lastSeenAt: new Date() }).where(eq(fimsSessions.tokenHash, tokenHash)),
      }).pipe(Effect.ignoreLogged)
    }
    return row.address
  })
}

/**
 * Wallet-signed auth. The client signs:
 *   `fims-wallet-v3\n{HOST}\n{METHOD}\n{PATHNAME[?CANONICAL_QUERY]}\n{TIMESTAMP_MS}\n{SHA256_HEX(BODY)}`
 * with its Solana keypair and sends:
 *   x-fims-address:   base58 public key
 *   x-fims-ts:        unix timestamp (ms)
 *   x-fims-sig:       ed25519 signature, base64
 *
 * Binding the host stops signatures captured on a rogue endpoint from being
 * replayed against the real API; binding the canonical query stops a captured
 * GET signature from being replayed with swapped parameters; binding the body
 * hash stops a captured signature from being replayed with a swapped payload.
 *
 * Preferred auth is a bearer session minted by `createSession` — the signed
 * path stays for compatibility but is only ever needed once per session.
 */
export function verifyWalletRequest(request: HttpServerRequest.HttpServerRequest) {
  return Effect.gen(function* () {
    // A bearer session wins when present — and when present but invalid the
    // request fails closed (no silent downgrade to signature auth).
    if (header(request, 'authorization').startsWith('Bearer ')) {
      return yield* verifyBearerSession(request)
    }

    const address = header(request, 'x-fims-address')
    const ts = Number(header(request, 'x-fims-ts'))
    const sigHeader = header(request, 'x-fims-sig')

    const fail = (reason: string) => Effect.fail(new AuthUnauthorized({ reason }))

    if (!address || !sigHeader || !Number.isFinite(ts)) return yield* fail('missing auth headers')
    if (Math.abs(Date.now() - ts) > MAX_SKEW_MS) return yield* fail('stale timestamp')

    // request.url may be a bare path — the base only kicks in when it is.
    // The real host comes from the Host header (the signed URL host must match
    // the endpoint the client actually called, else signatures are replayable
    // across hosts). request.text is cached by the platform, so reading it
    // after payload decoding returns the same buffered body.
    const url = new URL(request.url, 'https://fims.local')
    const host = header(request, 'host') || url.host
    const bodyText = yield* Effect.catchAll(request.text, () => Effect.succeed(''))
    const bodyHash = yield* sha256Hex(bodyText)
    // Malformed base58/base64 headers must fail with 401, not as a defect.
    const decode = <T>(decodeFn: () => T) =>
      Effect.try({ catch: () => new AuthUnauthorized({ reason: 'malformed signature or address' }), try: decodeFn })
    const publicKey = yield* decode(() => Uint8Array.from(getBase58Encoder().encode(address)))
    const signature = yield* decode(() => b64ToBytes(sigHeader))

    const verify = (resource: string) =>
      Effect.try({
        catch: () => new AuthUnauthorized({ reason: 'malformed signature or address' }),
        try: () =>
          ed25519.verify(
            signature,
            new TextEncoder().encode(`fims-wallet-v3\n${host}\n${request.method}\n${resource}\n${ts}\n${bodyHash}`),
            publicKey,
          ),
      })

    const query = canonicalizeQuery(url.searchParams)
    const valid = yield* verify(query ? `${url.pathname}?${query}` : url.pathname)
    if (!valid) return yield* fail('bad signature')

    // Replay lock for mutating requests: a valid signature is burned on
    // first use, so an intercepted request (or a client retry that re-sends
    // the exact same signed request) cannot apply the mutation twice within
    // the timestamp window. GET/HEAD are skipped — their signatures cannot
    // be replayed against a different resource anyway (method is signed).
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const { db } = yield* DatabaseService
      const inserted = yield* Effect.tryPromise({
        catch: (cause) => new DatabaseError({ cause }),
        try: () => db.insert(usedSignatures).values({ signature: sigHeader }).onConflictDoNothing().returning(),
      })
      if (!inserted.length) return yield* fail('signature already used')
      // Opportunistic purge: rows are only meaningful for MAX_SKEW_MS.
      if (Math.random() < 0.02) {
        yield* Effect.tryPromise({
          catch: () => new DatabaseError({ cause: 'signature purge failed' }),
          try: () => db.execute(sql`DELETE FROM used_signatures WHERE created_at < NOW() - INTERVAL '15 minutes'`),
        }).pipe(Effect.ignoreLogged)
      }
    }
    return address
  })
}

/**
 * Optional auth for reads: no auth headers → anonymous (Option.none).
 * Headers present but invalid → Unauthorized (fail closed).
 */
export function optionalWalletRequest(request: HttpServerRequest.HttpServerRequest) {
  return Effect.gen(function* () {
    if (!header(request, 'x-fims-address') && !header(request, 'x-fims-sig')) return Option.none<string>()
    return Option.some(yield* verifyWalletRequest(request))
  })
}

// ADMIN_ADDRESSES: comma-separated base58 pubkeys allowed to mutate any resource
const adminAddresses = () =>
  (process.env['ADMIN_ADDRESSES'] ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean)

export const isAdminAddress = (signer: string) => adminAddresses().includes(signer)

// The guided-tour mnemonic ships in the repository, so its derived address
// is an open secret — anyone can produce valid signatures for it. The demo
// member must stay readable but must never write to shared data (votes,
// conversions, address book): those are ledger-relevant and would be open
// to anonymous griefing. Admins can still manage the demo member.
const DEMO_ADDRESSES = new Set([FIMS_DEMO_ADDRESS])

export const isDemoAddress = (address: string) => DEMO_ADDRESSES.has(address)

export function requireNotDemo(signer: string) {
  return DEMO_ADDRESSES.has(signer) ? Effect.fail(new AuthForbidden({ address: signer })) : Effect.void
}

export function requireAdmin(signer: string) {
  return isAdminAddress(signer) ? Effect.void : Effect.fail(new AuthForbidden({ address: signer }))
}

export function requireOwnerOrAdmin(signer: string, ownerAddress: string) {
  if (DEMO_ADDRESSES.has(signer)) {
    return Effect.fail(new AuthForbidden({ address: signer }))
  }
  return signer === ownerAddress || isAdminAddress(signer)
    ? Effect.void
    : Effect.fail(new AuthForbidden({ address: signer }))
}

/**
 * Verify a raw ed25519 signature by `address` over `content`. Used for
 * wallet-link consent: the new wallet signs the canonical link message
 * separately from the HTTP request signature (which only proves the intent
 * of the already-linked signer).
 */
export function verifyAddressSignature(address: string, content: Uint8Array, signatureB64: string): boolean {
  try {
    return ed25519.verify(b64ToBytes(signatureB64), content, Uint8Array.from(getBase58Encoder().encode(address)))
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Bearer sessions (SIWS sign-in — one signature, then `Authorization: Bearer`)
// ---------------------------------------------------------------------------

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Canonical Sign-In-With-Solana message the client signs to mint a session.
 * The server rebuilds it from the fields in the request body — the message
 * text itself is never trusted (an injected statement/URI could otherwise
 * turn the session signature into a consent for something else).
 */
export function fimsSessionMessage(host: string, address: string, nonce: string, issuedAt: string): string {
  return (
    `${host} wants you to sign in with your Solana account:\n` +
    `${address}\n\n` +
    'Signs you in to the FiMs API for 7 days. This does not authorize transactions.\n\n' +
    `URI: ${host}\n` +
    'Version: 1\n' +
    'Chain ID: solana\n' +
    `Nonce: ${nonce}\n` +
    `Issued At: ${issuedAt}`
  )
}

/**
 * POST /fims/session: verify a fresh SIWS signature and mint a bearer token.
 * `issuedAt` must be within the signature skew window (freshness = replay
 * protection without a server-issued nonce round-trip), and the signature
 * is burned in used_signatures so the same login cannot be replayed.
 */
export function createSession(
  request: HttpServerRequest.HttpServerRequest,
  body: { address: string; issuedAt: string; nonce: string; signature: string },
) {
  return Effect.gen(function* () {
    const fail = (reason: string) => Effect.fail(new AuthUnauthorized({ reason }))
    const issuedAt = Date.parse(body.issuedAt)
    if (!Number.isFinite(issuedAt) || Math.abs(Date.now() - issuedAt) > MAX_SKEW_MS)
      return yield* fail('stale sign-in timestamp')
    if (!/^[a-zA-Z0-9]{16,64}$/.test(body.nonce)) return yield* fail('bad nonce')

    const url = new URL(request.url, 'https://fims.local')
    const host = header(request, 'host') || url.host
    const decode = <T>(decodeFn: () => T) =>
      Effect.try({ catch: () => new AuthUnauthorized({ reason: 'malformed signature or address' }), try: decodeFn })
    const publicKey = yield* decode(() => Uint8Array.from(getBase58Encoder().encode(body.address)))
    const signature = yield* decode(() => b64ToBytes(body.signature))
    const valid = yield* Effect.try({
      catch: () => new AuthUnauthorized({ reason: 'malformed signature or address' }),
      try: () =>
        ed25519.verify(
          signature,
          new TextEncoder().encode(fimsSessionMessage(host, body.address, body.nonce, body.issuedAt)),
          publicKey,
        ),
    })
    if (!valid) return yield* fail('bad signature')

    // Burn the sign-in signature — replaying it cannot mint a second session.
    const { db } = yield* DatabaseService
    const inserted = yield* Effect.tryPromise({
      catch: (cause) => new DatabaseError({ cause }),
      try: () => db.insert(usedSignatures).values({ signature: body.signature }).onConflictDoNothing().returning(),
    })
    if (!inserted.length) return yield* fail('signature already used')

    const tokenBytes = new Uint8Array(32)
    crypto.getRandomValues(tokenBytes)
    const token = Array.from(tokenBytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
    // Same input as verifyBearerSession: the token STRING, not the raw bytes.
    const tokenHash = yield* Effect.tryPromise({
      catch: () => new DatabaseError({ cause: 'token hashing failed' }),
      try: () => sha256HexBytes(new TextEncoder().encode(token)),
    })
    yield* Effect.tryPromise({
      catch: (cause) => new DatabaseError({ cause }),
      try: () =>
        db.insert(fimsSessions).values({ address: body.address, expiresAt, lastSeenAt: new Date(), tokenHash }),
    })
    return { expiresAt, token }
  })
}

/** DELETE /fims/session: revoke the bearer session carried in the request. */
export function deleteSession(request: HttpServerRequest.HttpServerRequest) {
  return Effect.gen(function* () {
    const bearer = header(request, 'authorization')
    if (!bearer.startsWith('Bearer ')) return yield* Effect.fail(new AuthUnauthorized({ reason: 'missing session' }))
    const tokenHash = yield* Effect.tryPromise({
      catch: () => new AuthUnauthorized({ reason: 'malformed session token' }),
      try: () => sha256HexBytes(new TextEncoder().encode(bearer.slice('Bearer '.length))),
    })
    const { db } = yield* DatabaseService
    yield* Effect.tryPromise({
      catch: (cause) => new DatabaseError({ cause }),
      try: () => db.delete(fimsSessions).where(eq(fimsSessions.tokenHash, tokenHash)),
    })
    return 'session revoked'
  })
}

/**
 * Step-up auth for sensitive mutations (delete user, link/unlink address):
 * on top of whatever auth authenticated the request, the wallet must sign a
 * FRESH confirmation binding host + method + resource + body. A stolen
 * bearer token alone can therefore not destroy or hijack a member account.
 *   `fims-confirm\n{HOST}\n{METHOD}\n{PATHNAME[?CANONICAL_QUERY]}\n{TS_MS}\n{SHA256_HEX(BODY)}`
 * sent as x-fims-confirm-ts / x-fims-confirm-sig.
 */
export function verifyFreshConfirmation(request: HttpServerRequest.HttpServerRequest, signer: string) {
  return Effect.gen(function* () {
    const fail = (reason: string) => Effect.fail(new AuthUnauthorized({ reason }))
    const ts = Number(header(request, 'x-fims-confirm-ts'))
    const sigHeader = header(request, 'x-fims-confirm-sig')
    if (!sigHeader || !Number.isFinite(ts)) return yield* fail('missing confirmation signature')
    if (Math.abs(Date.now() - ts) > MAX_SKEW_MS) return yield* fail('stale confirmation')

    const url = new URL(request.url, 'https://fims.local')
    const host = header(request, 'host') || url.host
    const bodyText = yield* Effect.catchAll(request.text, () => Effect.succeed(''))
    const bodyHash = yield* sha256Hex(bodyText)
    const decode = <T>(decodeFn: () => T) =>
      Effect.try({ catch: () => new AuthUnauthorized({ reason: 'malformed confirmation' }), try: decodeFn })
    const publicKey = yield* decode(() => Uint8Array.from(getBase58Encoder().encode(signer)))
    const signature = yield* decode(() => b64ToBytes(sigHeader))
    const query = canonicalizeQuery(url.searchParams)
    const resource = query ? `${url.pathname}?${query}` : url.pathname
    const valid = yield* Effect.try({
      catch: () => new AuthUnauthorized({ reason: 'malformed confirmation' }),
      try: () =>
        ed25519.verify(
          signature,
          new TextEncoder().encode(`fims-confirm\n${host}\n${request.method}\n${resource}\n${ts}\n${bodyHash}`),
          publicKey,
        ),
    })
    if (!valid) return yield* fail('bad confirmation signature')

    // Burn the confirmation — a captured one cannot be replayed.
    const { db } = yield* DatabaseService
    const inserted = yield* Effect.tryPromise({
      catch: (cause) => new DatabaseError({ cause }),
      try: () =>
        db
          .insert(usedSignatures)
          .values({ signature: `confirm:${sigHeader}` })
          .onConflictDoNothing()
          .returning(),
    })
    if (!inserted.length) return yield* fail('confirmation already used')
    return undefined
  })
}
