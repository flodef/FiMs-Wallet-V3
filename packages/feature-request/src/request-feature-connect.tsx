import { useRouteLoaderData } from 'react-router'

import type { RequestRouteData } from './data-access/request-route-loader.tsx'
import { RequestUiConnect } from './ui/request-ui-connect.tsx'

export function RequestFeatureConnect() {
  const { origin } = useRouteLoaderData('request') as RequestRouteData<undefined>

  return <RequestUiConnect origin={origin} />
}
