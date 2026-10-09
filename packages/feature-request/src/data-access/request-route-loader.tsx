import { getRequestService } from '@workspace/background/services/request'

export interface RequestRouteData<T> {
  data: T
  origin: string
}

export async function requestRouteLoader(): Promise<RequestRouteData<unknown>> {
  const result = await getRequestService().get()
  if (!result) {
    throw new Response('Not Found', { status: 404 })
  }

  return { data: result.data, origin: result.origin }
}
