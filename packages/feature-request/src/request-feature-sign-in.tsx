import type { SolanaSignInInput } from '@solana/wallet-standard-features'
import { useRouteLoaderData } from 'react-router'

import type { RequestRouteData } from './data-access/request-route-loader.tsx'
import { RequestUiSignIn } from './ui/request-ui-sign-in.tsx'

export function RequestFeatureSignIn() {
  const { data, origin } = useRouteLoaderData('request') as RequestRouteData<SolanaSignInInput[]>

  return <RequestUiSignIn data={data} origin={origin} />
}
