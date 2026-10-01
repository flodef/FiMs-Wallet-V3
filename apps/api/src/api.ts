import { HttpApi, OpenApi } from '@effect/platform'
import { FimsApi } from './routes/fims/api.ts'
import { RootApi } from './routes/root/api.ts'

export class Api extends HttpApi.make('api').add(RootApi).add(FimsApi).annotate(OpenApi.Title, 'FiMs') {}
