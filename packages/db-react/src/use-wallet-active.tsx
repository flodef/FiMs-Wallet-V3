import { AppError } from '@workspace/core/app-error'
import { useMemo } from 'react'
import { useAccountActive } from './use-account-active.tsx'
import { useWalletLive } from './use-wallet-live.tsx'

export function useWalletActive() {
  const account = useAccountActive()
  const wallets = useWalletLive()
  const activeWallet = useMemo(() => wallets.find((item) => item.id === account.walletId), [account.walletId, wallets])
  if (!activeWallet) {
    throw new AppError('noActiveWallet', 'No active wallet set.')
  }

  return activeWallet
}
