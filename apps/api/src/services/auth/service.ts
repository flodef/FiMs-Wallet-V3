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
// for the same method+path (both are part of the signed message).
const MAX_SKEW_MS = 5 * 60 * 1000

const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
const header = (request: HttpServerRequest.HttpServerRequest, name: string) =>
  Option.getOrElse(Headers.get(request.headers, name), () => '')

/**
 * Wallet-signed auth. The client signs:
 *   `fims-wallet-v3\n{METHOD}\n{PATHNAME}\n{TIMESTAMP_MS}`
 * with its Solana keypair and sends:
 *   x-fims-address:   base58 public key
 *   x-fims-ts:        unix timestamp (ms)
 *   x-fims-sig:       ed25519 signature, base64
 */
export function verifyWalletRequest(request: HttpServerRequest.HttpServerRequest) {
  return Effect.gen(function* () {
    const address = header(request, 'x-fims-address')
    const ts = Number(header(request, 'x-fims-ts'))
    const sigHeader = header(request, 'x-fims-sig')

    const fail = (reason: string) => Effect.fail(new AuthUnauthorized({ reason }))

    if (!address || !sigHeader || !Number.isFinite(ts)) return yield* fail('missing auth headers')
    if (Math.abs(Date.now() - ts) > MAX_SKEW_MS) return yield* fail('stale timestamp')

    const message = `fims-wallet-v3\n${request.method}\n${new URL(request.url).pathname}\n${ts}`

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

// ADMIN_ADDRESSES: comma-separated base58 pubkeys allowed to mutate any resource
const adminAddresses = () =>
  (process.env['ADMIN_ADDRESSES'] ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean)

export function requireOwnerOrAdmin(signer: string, ownerAddress: string) {
  return signer === ownerAddress || adminAddresses().includes(signer)
    ? Effect.void
    : Effect.fail(new AuthForbidden({ address: signer }))
}
