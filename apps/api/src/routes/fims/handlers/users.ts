import { HttpServerRequest } from '@effect/platform'
import { and, asc, eq, getTableColumns, ilike, sql } from 'drizzle-orm'
import { Effect, Option, type Schema } from 'effect'
import { userAddresses, users } from '../../../db/schema.js'
import { withDb } from '../../../db/service.js'
import {
  AuthForbidden,
  isAdminAddress,
  isDemoAddress,
  optionalWalletRequest,
  requireAdmin,
  verifyAddressSignature,
  verifyFreshConfirmation,
  verifyWalletRequest,
} from '../../../services/auth/service.js'
import { BadRequest, type CreateUserBody, type LinkUserAddressBody, type UpdateUserBody } from '../api.js'
import {
  addressLinkedToUser,
  auditAdmin,
  insertFailed,
  linkAddressMessage,
  memberProfileEditAllowed,
  normalizeName,
  notFound,
  pageParams,
  requireCanonicalOrAdmin,
  requireLinkedOrAdmin,
  visibilityFilter,
} from '../helpers.js'

export const handleUsers = ({
  urlParams,
}: {
  urlParams: {
    address?: string | undefined
    limit?: number | undefined
    name?: string | undefined
    offset?: number | undefined
  }
}) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const signer = yield* optionalWalletRequest(request)
    const signerAddress = Option.getOrNull(signer)
    const { limit, offset } = pageParams(urlParams)
    return yield* withDb((db) =>
      db
        .select({
          ...getTableColumns(users),

          // All linked addresses (canonical + aliases) so the client
          // can recognize a member from any of its wallets.
          addresses: sql<
            string[]
          >`array_prepend(${users.address}, coalesce((select array_agg(${userAddresses.address}) from ${userAddresses} where ${userAddresses.userId} = ${users.id}), '{}'))`.as(
            'addresses',
          ),
          // A member's intended risk allocation is personal finance info:
          // only the member (any linked wallet) and admins see it — the
          // public directory does not need it (audit L-4).
          riskTarget: sql<number | null>`case when ${
            signerAddress === null
              ? sql`false`
              : isAdminAddress(signerAddress)
                ? sql`true`
                : addressLinkedToUser(signerAddress)
          } then ${users.riskTarget} else null end`.as('risk_target'),
        })
        .from(users)
        .where(
          and(
            urlParams.name ? ilike(users.name, urlParams.name) : undefined,
            urlParams.address ? addressLinkedToUser(urlParams.address) : undefined,
            visibilityFilter(signer),
          ),
        )
        .orderBy(asc(users.id))
        .limit(limit)
        .offset(offset),
    )
  })

export const handleCreateUser = ({ payload }: { payload: Schema.Schema.Type<typeof CreateUserBody> }) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const signer = yield* verifyWalletRequest(request)
    // Self-registration only: the owner check is inlined (not
    // requireOwnerOrAdmin) because the public demo wallet must be
    // allowed to register its own row during the guided tour.
    if (signer !== payload.address) {
      yield* requireAdmin(signer)
    }
    // An admin address must never become a member identity: the same key
    // would then pass both requireAdmin and requireMember, blurring the
    // ops/community separation (audit M-10).
    if (isAdminAddress(payload.address)) {
      return yield* Effect.fail(new BadRequest({ reason: 'admin addresses cannot be member identities' }))
    }
    // Display names are unique across members — same rule as
    // updateUser. Without it, self-registration could squat another
    // member's public name. Admins keep the override.
    const name = normalizeName(payload.name)
    if (name.length === 0) return yield* Effect.fail(new BadRequest({ reason: 'name cannot be blank' }))
    if (!isAdminAddress(signer)) {
      const taken = yield* withDb((db) =>
        db.select({ id: users.id }).from(users).where(sql`lower(${users.name}) = lower(${name})`),
      )
      if (taken.length) return yield* Effect.fail(new BadRequest({ reason: `name already taken: ${name}` }))
    }
    // The public-mnemonic wallet gets exactly one immutable name —
    // anyone can sign for it, so a hostile rename would stick until
    // an admin noticed.
    if (isDemoAddress(payload.address) && !isAdminAddress(signer) && name !== 'Démo') {
      return yield* Effect.fail(new BadRequest({ reason: 'the demo member is always named Démo' }))
    }
    const rows = yield* withDb((db) =>
      db
        .insert(users)
        .values({ ...payload, name })
        .returning(),
    )
    const created = rows[0]
    if (!created) return yield* Effect.fail(insertFailed())
    yield* auditAdmin(signer, 'create_user', String(created.id), payload)
    return created
  })

export const handleUpdateUser = ({
  path,
  payload,
}: {
  path: { id: number }
  payload: Schema.Schema.Type<typeof UpdateUserBody>
}) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const signer = yield* verifyWalletRequest(request)
    yield* requireLinkedOrAdmin(signer, path.id)
    // Privileged fields are admin-only: `address` reassignment would let a
    // member squat someone else's pubkey (member resolution picks the
    // lowest-id row → the squatter's address book is shown to the victim)

    // and `isPro` is a community trust badge.
    const isAdmin = isAdminAddress(signer)
    if (!isAdmin && (payload.address !== undefined || payload.isPro !== undefined)) {
      return yield* Effect.fail(new AuthForbidden({ address: signer }))
    }
    // Same admin∩member collision guard as createUser (audit M-10).
    if (payload.address !== undefined && isAdminAddress(payload.address)) {
      return yield* Effect.fail(new BadRequest({ reason: 'admin addresses cannot be member identities' }))
    }
    // The daily edit allowance covers identity fields only — the
    // rebalance target is a preference and stays freely editable.
    const touchesIdentity = payload.name !== undefined || payload.isPublic !== undefined
    if (!isAdmin && touchesIdentity) {
      yield* memberProfileEditAllowed(path.id)
    }
    const name = payload.name === undefined ? undefined : normalizeName(payload.name)
    if (name !== undefined && name.length === 0)
      return yield* Effect.fail(new BadRequest({ reason: 'name cannot be blank' }))
    if (!isAdmin) {
      if (name !== undefined) {
        // The demo member's name is fixed — its keys are public, so a
        // rename could come from literally anyone.
        const target = yield* withDb((db) =>
          db.select({ address: users.address }).from(users).where(eq(users.id, path.id)),
        )
        if (target[0] && isDemoAddress(target[0].address) && name !== 'Démo') {
          return yield* Effect.fail(new BadRequest({ reason: 'the demo member is always named Démo' }))
        }
        const taken = yield* withDb((db) =>
          db
            .select({ id: users.id })
            .from(users)
            .where(and(sql`lower(${users.name}) = lower(${name})`, sql`${users.id} <> ${path.id}`)),
        )
        if (taken.length) return yield* Effect.fail(new BadRequest({ reason: `name already taken: ${name}` }))
      }
    }
    const rows = yield* withDb((db) =>
      db
        .update(users)
        .set({
          ...payload,
          ...(name === undefined ? {} : { name }),

          // Only member self-edits consume the daily edit allowance.
          ...(isAdmin || !touchesIdentity ? {} : { profileUpdatedAt: new Date() }),
          updatedAt: new Date(),
        })
        .where(eq(users.id, path.id))
        .returning(),
    )
    const updated = rows[0]
    if (!updated) return yield* Effect.fail(notFound(`user ${path.id}`))
    yield* auditAdmin(signer, 'update_user', String(updated.id), payload)
    return updated
  })

export const handleDeleteUser = ({ path }: { path: { id: number } }) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const signer = yield* verifyWalletRequest(request)
    yield* requireCanonicalOrAdmin(signer, path.id)
    // Step-up: a bearer session alone cannot destroy a member — the
    // wallet must re-sign this exact action.
    yield* verifyFreshConfirmation(request, signer)
    const rows = yield* withDb((db) => db.delete(users).where(eq(users.id, path.id)).returning({ id: users.id }))
    if (!rows[0]) return yield* Effect.fail(notFound(`user ${path.id}`))
    yield* auditAdmin(signer, 'delete_user', String(path.id))
    return `deleted user ${path.id}`
  })

export const handleAddUserAddress = ({
  path,
  payload,
}: {
  path: { id: number }
  payload: Schema.Schema.Type<typeof LinkUserAddressBody>
}) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const signer = yield* verifyWalletRequest(request)
    yield* requireCanonicalOrAdmin(signer, path.id)
    yield* verifyFreshConfirmation(request, signer)
    if (!isAdminAddress(signer)) {
      if (!payload.signature) return yield* Effect.fail(new BadRequest({ reason: 'missing link consent signature' }))
      if (!verifyAddressSignature(payload.address, linkAddressMessage(path.id, payload.address), payload.signature))
        return yield* Effect.fail(new BadRequest({ reason: 'invalid link consent signature' }))
    }
    // Admin keys authenticate ops; they must not double as member aliases
    // (audit M-10).
    if (isAdminAddress(payload.address)) {
      return yield* Effect.fail(new BadRequest({ reason: 'admin addresses cannot be linked to a member' }))
    }
    // A canonical users.address already identifies a member: it can
    // never become an alias (resolution would be ambiguous).
    const canonical = yield* withDb((db) =>
      db.select({ id: users.id }).from(users).where(eq(users.address, payload.address)),
    )
    if (canonical[0])
      return yield* Effect.fail(
        new BadRequest({
          reason:
            canonical[0].id === path.id
              ? 'address is already the canonical address of this member'
              : 'address already belongs to another member',
        }),
      )
    const existing = yield* withDb((db) =>
      db.select({ userId: userAddresses.userId }).from(userAddresses).where(eq(userAddresses.address, payload.address)),
    )
    if (existing[0]) {
      if (existing[0].userId === path.id)
        return yield* Effect.fail(new BadRequest({ reason: 'address is already linked to this member' }))
      // Moving an alias between members would silently hand one
      // member's history to another — admins must unlink first.
      return yield* Effect.fail(new BadRequest({ reason: 'address is already linked to another member' }))
    }
    const rows = yield* withDb((db) =>
      db.insert(userAddresses).values({ address: payload.address, userId: path.id }).returning(),
    )
    const created = rows[0]
    if (!created) return yield* Effect.fail(insertFailed())
    yield* auditAdmin(signer, 'link_user_address', `${path.id}/${payload.address}`, payload)
    return created
  })

export const handleRemoveUserAddress = ({ path }: { path: { address: string; id: number } }) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const signer = yield* verifyWalletRequest(request)
    yield* requireCanonicalOrAdmin(signer, path.id)
    yield* verifyFreshConfirmation(request, signer)
    const rows = yield* withDb((db) =>
      db
        .delete(userAddresses)
        .where(and(eq(userAddresses.userId, path.id), eq(userAddresses.address, path.address)))
        .returning({ id: userAddresses.id }),
    )
    if (!rows[0]) return yield* Effect.fail(notFound(`linked address ${path.address}`))
    yield* auditAdmin(signer, 'unlink_user_address', `${path.id}/${path.address}`)
    return `unlinked address ${path.address} from user ${path.id}`
  })
