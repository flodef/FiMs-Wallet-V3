import { HttpServerRequest } from '@effect/platform'
import { Effect, type Schema } from 'effect'
import { createSession, deleteSession } from '../../../services/auth/service.js'
import type { CreateSessionBody } from '../api.js'

export const handleCreateSession = ({ payload }: { payload: Schema.Schema.Type<typeof CreateSessionBody> }) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    return yield* createSession(request, payload)
  })

export const handleDeleteSession = () =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    return yield* deleteSession(request)
  })
