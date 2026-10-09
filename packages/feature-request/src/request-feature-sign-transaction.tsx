import type { SolanaSignTransactionInput } from '@solana/wallet-standard-features'
import { useRouteLoaderData } from 'react-router'

import type { RequestRouteData } from './data-access/request-route-loader.tsx'
import { RequestUiSignTransaction } from './ui/request-ui-sign-transaction.tsx'

export function RequestFeatureSignTransaction() {
  const { data, origin } = useRouteLoaderData('request') as RequestRouteData<SolanaSignTransactionInput[]>

  return <RequestUiSignTransaction data={data} origin={origin} />
}
