import { HttpServerRequest } from '@effect/platform'
import { and, eq, sql } from 'drizzle-orm'
import { Effect, Option, type Schema } from 'effect'
import { fimsSettings, voteBallots, voteOptions, votes } from '../../../db/schema.js'
import { withDb, withTransaction } from '../../../db/service.js'
import {
  AuthForbidden,
  isAdminAddress,
  optionalWalletRequest,
  requireAdmin,
  requireNotDemo,
  verifyWalletRequest,
} from '../../../services/auth/service.js'
import { ballotChangeRetryAt } from '../../../vote-ballot-rules.js'
import {
  BadRequest,
  type CastBallotBody,
  type CreateVoteBody,
  type UpdateConfigBody,
  type UpdateVoteBody,
} from '../api.js'
import {
  auditAdmin,
  insertFailed,
  loadFimsConfig,
  loadVotesWithResults,
  loadVoteWeights,
  notFound,
  PROPOSAL_THRESHOLD_KEY,
  requireMember,
} from '../helpers.js'

export const handleVotes = () =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const signer = yield* optionalWalletRequest(request)
    return yield* loadVotesWithResults(signer)
  })

export const handleCreateVote = ({ payload }: { payload: Schema.Schema.Type<typeof CreateVoteBody> }) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const signer = yield* verifyWalletRequest(request)
    // Members submit tontine proposals; they land as drafts an admin
    // must open. Eligibility: the proposer's latest invested amount
    // must strictly exceed proposal_threshold × total invested.
    let proposerId: number | null = null
    if (!isAdminAddress(signer)) {
      yield* requireNotDemo(signer)
      if (payload.kind !== 'tontine')
        return yield* Effect.fail(new BadRequest({ reason: 'member proposals must target the tontine' }))
      const member = yield* requireMember(signer)
      const [config, weights] = yield* Effect.all([loadFimsConfig, loadVoteWeights])
      const invested = weights.invested.get(member.id) ?? 0
      if (!(invested > config.proposalThreshold * config.totalInvested))
        return yield* Effect.fail(new AuthForbidden({ address: signer }))
      proposerId = member.id
    }
    // Vote + options in one transaction — a failed options insert
    // used to leave a vote with no options (permanently unusable).
    const created = yield* withTransaction(async (tx) => {
      const inserted = await tx
        .insert(votes)
        .values({
          closesAt: payload.closesAt ?? null,
          description: payload.description ?? null,
          kind: isAdminAddress(signer) ? payload.kind : 'tontine',
          proposerId,
          title: payload.title,
        })
        .returning()
      const vote = inserted[0]
      if (!vote) return null
      await tx
        .insert(voteOptions)
        .values(payload.options.map((label, sortOrder) => ({ label, sortOrder, voteId: vote.id })))
      return vote
    })
    const vote = created
    if (!vote) return yield* Effect.fail(insertFailed())
    yield* auditAdmin(signer, 'create_vote', String(vote.id), payload)
    const list = yield* loadVotesWithResults(Option.some(signer))
    const found = list.find((v) => v.id === vote.id)
    if (!found) return yield* Effect.fail(notFound(`vote ${vote.id}`))
    return found
  })

export const handleUpdateVote = ({
  path,
  payload,
}: {
  path: { id: number }
  payload: Schema.Schema.Type<typeof UpdateVoteBody>
}) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const signer = yield* verifyWalletRequest(request)
    yield* requireAdmin(signer)
    const rows = yield* withDb((db) =>
      db.update(votes).set({ status: payload.status }).where(eq(votes.id, path.id)).returning(),
    )
    if (!rows[0]) return yield* Effect.fail(notFound(`vote ${path.id}`))
    yield* auditAdmin(signer, 'update_vote', String(path.id), payload)
    const list = yield* loadVotesWithResults(Option.some(signer))
    const found = list.find((v) => v.id === path.id)
    if (!found) return yield* Effect.fail(notFound(`vote ${path.id}`))
    return found
  })

export const handleCastBallot = ({
  path,
  payload,
}: {
  path: { id: number }
  payload: Schema.Schema.Type<typeof CastBallotBody>
}) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const signer = yield* verifyWalletRequest(request)
    yield* requireNotDemo(signer)
    const voteRows = yield* withDb((db) => db.select().from(votes).where(eq(votes.id, path.id)))
    const vote = voteRows[0]
    if (!vote) return yield* Effect.fail(notFound(`vote ${path.id}`))
    if (vote.status !== 'open' || (vote.closesAt && vote.closesAt.getTime() < Date.now()))
      return yield* Effect.fail(new BadRequest({ reason: 'vote is not open' }))
    const member = yield* requireMember(signer)
    const optionRows = yield* withDb((db) =>
      db.select({ id: voteOptions.id }).from(voteOptions).where(eq(voteOptions.voteId, path.id)),
    )
    if (!optionRows.some((o) => o.id === payload.optionId))
      return yield* Effect.fail(new BadRequest({ reason: `option ${payload.optionId} is not part of this vote` }))
    // A decision can be changed once per 24 h — re-selecting the same
    // option is a no-op, not a change. The member lock serializes
    // concurrent casts so the cooldown cannot be double-passed.
    const ballotOutcome = yield* withTransaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM users WHERE id = ${member.id} FOR UPDATE`)
      const existingBallots = await tx
        .select({ optionId: voteBallots.optionId, updatedAt: voteBallots.updatedAt })
        .from(voteBallots)
        .where(and(eq(voteBallots.voteId, path.id), eq(voteBallots.userId, member.id)))
      const retryAt = ballotChangeRetryAt(existingBallots[0] ?? null, payload.optionId)
      if (retryAt) return { retryAt } as const
      await tx
        .insert(voteBallots)
        .values({ optionId: payload.optionId, userId: member.id, voteId: path.id })
        .onConflictDoUpdate({
          set: { optionId: payload.optionId, updatedAt: new Date() },
          target: [voteBallots.voteId, voteBallots.userId],
        })
      return { cast: true } as const
    })
    if ('retryAt' in ballotOutcome) {
      return yield* Effect.fail(
        new BadRequest({
          reason: `ballot changeable once per day — retry at ${ballotOutcome.retryAt.toISOString()}`,
        }),
      )
    }
    const list = yield* loadVotesWithResults(Option.some(signer))
    const found = list.find((v) => v.id === path.id)
    if (!found) return yield* Effect.fail(notFound(`vote ${path.id}`))
    return found
  })

export const handleConfig = () =>
  Effect.gen(function* () {
    return yield* loadFimsConfig
  })

export const handleUpdateConfig = ({ payload }: { payload: Schema.Schema.Type<typeof UpdateConfigBody> }) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const signer = yield* verifyWalletRequest(request)
    yield* requireAdmin(signer)
    yield* withDb((db) =>
      db
        .insert(fimsSettings)
        .values({ key: PROPOSAL_THRESHOLD_KEY, value: String(payload.proposalThreshold) })
        .onConflictDoUpdate({
          set: { updatedAt: new Date(), value: String(payload.proposalThreshold) },
          target: fimsSettings.key,
        }),
    )
    yield* auditAdmin(signer, 'update_config', PROPOSAL_THRESHOLD_KEY, payload)
    return yield* loadFimsConfig
  })
