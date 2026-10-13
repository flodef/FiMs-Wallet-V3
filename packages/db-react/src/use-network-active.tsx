import { AppError } from '@workspace/core/app-error'
import { useMemo } from 'react'
import { useNetworkLive } from './use-network-live.tsx'
import { useSetting } from './use-setting.tsx'

export function useNetworkActive() {
  const networks = useNetworkLive()
  const [activeNetworkId] = useSetting('activeNetworkId')
  const activeNetwork = useMemo(() => networks.find((item) => item.id === activeNetworkId), [activeNetworkId, networks])
  if (!activeNetwork) {
    throw new AppError('noActiveNetwork', 'No active network set.')
  }

  return activeNetwork
}
