import { useQueryClient } from '@tanstack/react-query'
import { useAppContext } from '@workspace/context-react/use-app-context'
import { useEffect } from 'react'
import { vaultStatusQueryKey } from './options-vault.ts'
import { useVaultStatus } from './use-vault-status.ts'

// An unlocked tab left open is a signing oracle for anyone with access to
// the browser (physical or remote). After this much inactivity the vault
// re-locks and secrets must be unlocked again before they can sign.
const AUTO_LOCK_MS = 5 * 60 * 1000

const ACTIVITY_EVENTS = ['keydown', 'mousedown', 'pointerdown', 'scroll', 'touchstart'] as const

export function useVaultAutoLock() {
  const context = useAppContext()
  const queryClient = useQueryClient()
  const { data: status } = useVaultStatus()

  useEffect(() => {
    if (!status?.isUnlocked) {
      return
    }
    const lock = () => {
      context.vault.lock()
      queryClient.invalidateQueries({ queryKey: vaultStatusQueryKey })
    }
    let lastActivity = Date.now()
    let timer = setTimeout(lock, AUTO_LOCK_MS)
    const reset = () => {
      lastActivity = Date.now()
      clearTimeout(timer)
      timer = setTimeout(lock, AUTO_LOCK_MS)
    }
    // Background tabs freeze timers: a vault could stay unlocked for hours
    // while hidden. Re-check elapsed time when the tab resurfaces and lock
    // immediately if the budget ran out in the background.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastActivity > AUTO_LOCK_MS) {
        lock()
      }
    }
    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, reset, { passive: true })
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearTimeout(timer)
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, reset)
      }
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [context, queryClient, status?.isUnlocked])
}
