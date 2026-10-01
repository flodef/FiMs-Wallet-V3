import { HttpApiBuilder } from '@effect/platform'
import { Layer } from 'effect'
import { Api } from './api.ts'
import { HttpFimsLive } from './routes/fims/http.ts'
import { HttpRootLive } from './routes/root/http.ts'

export const ApiLive = Layer.provide(HttpApiBuilder.api(Api), [HttpRootLive, HttpFimsLive])
