import { AppError } from '@workspace/core/app-error'
import type { Account } from '@workspace/db/account/account'
import { useAccountReadSecretKey } from './use-account-read-secret-key.tsx'

export function useAccountSecretKey() {
  const readSecretKeyMutation = useAccountReadSecretKey()
  return async ({ account }: { account: Account }) => {
    const secretKey = await readSecretKeyMutation.mutateAsync({ id: account.id })

    if (!secretKey) {
      throw new AppError('secretKeyMissing', 'No secret key for this account')
    }

    return secretKey
  }
}
