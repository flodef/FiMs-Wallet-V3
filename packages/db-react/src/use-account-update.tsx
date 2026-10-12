import { useMutation } from '@tanstack/react-query'
import { useAppContext } from '@workspace/context-react/use-app-context'
import type { AccountUpdateMutateOptions } from './options-account.tsx'
import { optionsAccount } from './options-account.tsx'

export function useAccountUpdate(props: AccountUpdateMutateOptions = {}) {
  const ctx = useAppContext()
  return useMutation(optionsAccount.update(ctx, props))
}
