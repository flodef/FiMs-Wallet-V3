// cspell:ignore replayable pubkeys
import { Headers, type HttpServerRequest } from '@effect/platform'
import { ed25519 } from '@noble/curves/ed25519'
import { getBase58Encoder } from '@solana/codecs-strings'
import { Effect, Option, Schema } from 'effect'

export class AuthUnauthorized extends Schema.TaggedError<AuthUnauthorized>()('AuthUnauthorized', {
  reason: Schema.String,
}) {}

export class AuthForbidden extends Schema.TaggedError<AuthForbidden>()('AuthForbidden', {
  address: Schema.String,
}) {}

// 5 min window — a signed request is replayable only within it, and only
// for the same host+method+path+body (all are part of the signed message).
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

/**
 * Wallet-signed auth. The client signs:
 *   `fims-wallet-v3\n{HOST}\n{METHOD}\n{PATHNAME}\n{TIMESTAMP_MS}\n{SHA256_HEX(BODY)}`
 * with its Solana keypair and sends:
 *   x-fims-address:   base58 public key
 *   x-fims-ts:        unix timestamp (ms)
 *   x-fims-sig:       ed25519 signature, base64
 *
 * Binding the host stops signatures captured on a rogue endpoint from being
 * replayed against the real API; binding the body hash stops a captured
 * signature from being replayed with a swapped payload.
 */
export function verifyWalletRequest(request: HttpServerRequest.HttpServerRequest) {
  return Effect.gen(function* () {
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
    const message = `fims-wallet-v3\n${host}\n${request.method}\n${url.pathname}\n${ts}\n${bodyHash}`

    const valid = yield* Effect.try({
      catch: () => new AuthUnauthorized({ reason: 'malformed signature or address' }),
      try: () =>
        ed25519.verify(
          b64ToBytes(sigHeader),
          new TextEncoder().encode(message),
          Uint8Array.from(getBase58Encoder().encode(address)),
        ),
    })

    if (!valid) return yield* fail('bad signature')
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

export function requireAdmin(signer: string) {
  return isAdminAddress(signer) ? Effect.void : Effect.fail(new AuthForbidden({ address: signer }))
}

export function requireOwnerOrAdmin(signer: string, ownerAddress: string) {
  return signer === ownerAddress || isAdminAddress(signer)
    ? Effect.void
    : Effect.fail(new AuthForbidden({ address: signer }))
}
