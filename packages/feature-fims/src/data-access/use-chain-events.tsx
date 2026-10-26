import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { useFimsEndpoint } from './use-fims.tsx'

// Near-realtime chain events: Helius delivers watched-address transactions to
// POST /fims/chain/webhook, the API records them in chain_events, and this
// hook short-polls the cursor feed. On a hit it invalidates every query whose
// key mentions the touched address — balances, history, member tiles refresh
// within seconds instead of on the next user action. The serial id is the
// cursor; persisting it skips already-seen rows across reloads.
const POLL_MS = 45_000
const CURSOR_KEY = 'fims.chain-events-cursor'

type ChainEvent = { address: string; id: number; signature: string }

export function useChainEvents() {
  const endpoint = useFimsEndpoint()
  const queryClient = useQueryClient()
  const cursor = useRef(Number(localStorage.getItem(CURSOR_KEY) ?? 0))

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      // A background tab polls nothing: 24h parked would burn 1.9k requests a
      // day for zero benefit. Visibility change fires a catch-up tick anyway.
      if (document.visibilityState === 'hidden') return
      try {
        const res = await fetch(`${endpoint}/chain/events?after=${cursor.current}`, {
          signal: AbortSignal.timeout(15_000),
        })
        if (!res.ok) return
        const events = (await res.json()) as ChainEvent[]
        const last = events.at(-1)
        if (cancelled || !last) return
        cursor.current = last.id
        localStorage.setItem(CURSOR_KEY, String(cursor.current))
        for (const event of events) {
          void queryClient.invalidateQueries({
            predicate: (query) => JSON.stringify(query.queryKey).includes(event.address),
          })
        }
      } catch {
        // Network hiccup — the next tick retries with the same cursor.
      }
    }
    void tick()
    const timer = setInterval(tick, POLL_MS)
    document.addEventListener('visibilitychange', tick)
    return () => {
      cancelled = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [endpoint, queryClient])
}

export function FimsChainEvents() {
  useChainEvents()
  return null
}
