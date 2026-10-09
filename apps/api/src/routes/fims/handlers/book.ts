import { HttpServerRequest } from '@effect/platform'
import { and, asc, eq, type SQL } from 'drizzle-orm'
import { Effect, type Schema } from 'effect'
import { addressBook, users } from '../../../db/schema.js'
import { withDb } from '../../../db/service.js'
import { optionalWalletRequest, verifyWalletRequest } from '../../../services/auth/service.js'
import type { CreateAddressBookEntryBody, UpdateAddressBookEntryBody } from '../api.js'
import {
  auditAdmin,
  insertFailed,
  notFound,
  ownerUserIdOfAddressBookEntry,
  pageParams,
  requireLinkedOrAdmin,
  visibilityFilter,
} from '../helpers.js'

export const handleAddressBook = ({
  urlParams,
}: {
  urlParams: { limit?: number | undefined; offset?: number | undefined; userId?: number | undefined }
}) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const signer = yield* optionalWalletRequest(request)
    const { limit, offset } = pageParams(urlParams)
    const filters: SQL[] = []
    if (urlParams.userId !== undefined) filters.push(eq(addressBook.userId, urlParams.userId))
    const privacy = visibilityFilter(signer)
    if (privacy) filters.push(privacy)
    const rows = yield* withDb((db) =>
      db
        .select({ entry: addressBook })
        .from(addressBook)
        .innerJoin(users, eq(addressBook.userId, users.id))
        .where(filters.length ? and(...filters) : undefined)
        .orderBy(asc(addressBook.label), asc(addressBook.id))
        .limit(limit)
        .offset(offset),
    )
    return rows.map((r) => r.entry)
  })

export const handleCreateAddressBookEntry = ({
  payload,
}: {
  payload: Schema.Schema.Type<typeof CreateAddressBookEntryBody>
}) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const signer = yield* verifyWalletRequest(request)
    yield* requireLinkedOrAdmin(signer, payload.userId)
    const rows = yield* withDb((db) =>
      db
        .insert(addressBook)
        .values({ ...payload, type: payload.type ?? 'other' })
        .returning(),
    )
    const created = rows[0]
    if (!created) return yield* Effect.fail(insertFailed())
    yield* auditAdmin(signer, 'create_address_book_entry', String(created.id), payload)
    return created
  })

export const handleUpdateAddressBookEntry = ({
  path,
  payload,
}: {
  path: { id: number }
  payload: Schema.Schema.Type<typeof UpdateAddressBookEntryBody>
}) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const signer = yield* verifyWalletRequest(request)
    const owner = yield* ownerUserIdOfAddressBookEntry(path.id)
    yield* requireLinkedOrAdmin(signer, owner)
    const rows = yield* withDb((db) =>
      db.update(addressBook).set(payload).where(eq(addressBook.id, path.id)).returning(),
    )
    const updated = rows[0]
    if (!updated) return yield* Effect.fail(notFound(`address book entry ${path.id}`))
    yield* auditAdmin(signer, 'update_address_book_entry', String(path.id), payload)
    return updated
  })

export const handleDeleteAddressBookEntry = ({ path }: { path: { id: number } }) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const signer = yield* verifyWalletRequest(request)
    const owner = yield* ownerUserIdOfAddressBookEntry(path.id)
    yield* requireLinkedOrAdmin(signer, owner)
    const rows = yield* withDb((db) =>
      db.delete(addressBook).where(eq(addressBook.id, path.id)).returning({ id: addressBook.id }),
    )
    if (!rows[0]) return yield* Effect.fail(notFound(`address book entry ${path.id}`))
    yield* auditAdmin(signer, 'delete_address_book_entry', String(path.id))
    return `deleted address book entry ${path.id}`
  })
