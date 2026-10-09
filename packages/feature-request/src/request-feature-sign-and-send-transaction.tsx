import type { SolanaSignAndSendTransactionInput } from '@solana/wallet-standard-features'
import { useRouteLoaderData } from 'react-router'

import type { RequestRouteData } from './data-access/request-route-loader.tsx'
import { RequestUiSignAndSendTransaction } from './ui/request-ui-sign-and-send-transaction.tsx'

export function RequestFeatureSignAndSendTransaction() {
  const { data, origin } = useRouteLoaderData('request') as RequestRouteData<SolanaSignAndSendTransactionInput[]>

  return <RequestUiSignAndSendTransaction data={data} origin={origin} />
}
