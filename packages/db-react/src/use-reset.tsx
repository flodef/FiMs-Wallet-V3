import { mutationOptions, type QueryClient, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAppContext } from '@workspace/context-react/use-app-context'
import type { DbContext } from '@workspace/db/db-context'
import { reset } from '@workspace/db/reset'
import { i18n } from '@workspace/i18n'
import { fimsClearAllSessions } from '@workspace/solana-client/fims-session'
import { toastSuccess } from '@workspace/ui/lib/toast-success'

export function resetMutationOptions(ctx: DbContext, queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async () => {
      fimsClearAllSessions()
      await reset(ctx)
      queryClient.clear()
      toastSuccess(i18n.t(($) => $.toastDatabaseReset, { ns: 'ui' }))
    },
  })
}

export function useReset() {
  const ctx = useAppContext()
  const queryClient = useQueryClient()

  return useMutation(resetMutationOptions(ctx, queryClient))
}
