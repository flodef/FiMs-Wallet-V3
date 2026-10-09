import type { SolanaSignMessageInput } from '@solana/wallet-standard-features'
import { useRouteLoaderData } from 'react-router'

import type { RequestRouteData } from './data-access/request-route-loader.tsx'
import { RequestUiSignMessage } from './ui/request-ui-sign-message.tsx'

export function RequestFeatureSignMessage() {
  const { data, origin } = useRouteLoaderData('request') as RequestRouteData<SolanaSignMessageInput[]>

  return <RequestUiSignMessage data={data} origin={origin} />
}
