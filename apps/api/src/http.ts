import { HttpApiBuilder } from '@effect/platform'
import { Layer } from 'effect'
import { Api } from './api.js'
import { HttpFimsLive } from './routes/fims/http.js'
import { HttpRootLive } from './routes/root/http.js'

export const ApiLive = Layer.provide(HttpApiBuilder.api(Api), [HttpRootLive, HttpFimsLive])
