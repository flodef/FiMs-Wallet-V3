import { mutationOptions, useMutation } from '@tanstack/react-query'
import type { Account } from '@workspace/db/account/account'
import type { Network } from '@workspace/db/network/network'
import { i18n } from '@workspace/i18n'
import type { SolanaClient } from '@workspace/solana-client/solana-client'
import type { SplTokenCreateTokenMintOptions } from '@workspace/solana-client/spl-token-create-token-mint'
import { splTokenCreateTokenMint } from '@workspace/solana-client/spl-token-create-token-mint'
import { toastError } from '@workspace/ui/lib/toast-error'
import { toastSuccess } from '@workspace/ui/lib/toast-success'
import { useSolanaClient } from './use-solana-client.tsx'

export function splTokenCreateTokenMintMutationOptions(client: SolanaClient) {
  return mutationOptions({
    mutationFn: async (input: SplTokenCreateTokenMintOptions) => splTokenCreateTokenMint(client, input),
    onError: () => {
      toastError(i18n.t(($) => $.toastTokenMintCreateFailed, { ns: 'ui' }))
    },
    onSuccess: () => {
      toastSuccess(i18n.t(($) => $.toastTokenMintCreated, { ns: 'ui' }))
    },
  })
}

export function useSplTokenCreateTokenMint(props: { account: Account; network: Network }) {
  const client = useSolanaClient({ network: props.network })

  return useMutation(splTokenCreateTokenMintMutationOptions(client))
}
