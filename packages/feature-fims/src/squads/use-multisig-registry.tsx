import type { Address } from '@solana/kit'
import { useCallback, useEffect, useState } from 'react'

export interface MultisigRegistryEntry {
  addedAt: number
  label: string
  networkId: string
  pda: Address
}

const STORAGE_KEY = 'fims-squads-registry'

function readRegistry(): MultisigRegistryEntry[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed.filter(
      (entry): entry is MultisigRegistryEntry =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as MultisigRegistryEntry).pda === 'string' &&
        typeof (entry as MultisigRegistryEntry).networkId === 'string',
    )
  } catch {
    return []
  }
}

function writeRegistry(entries: MultisigRegistryEntry[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
}

// Local directory of multisigs this wallet knows about: ones created here
// plus ones added by address. On-chain membership is verified when loading
// each entry, so a stale address simply shows an error.
export function useMultisigRegistry({ networkId }: { networkId: string }) {
  const [entries, setEntries] = useState<MultisigRegistryEntry[]>(() => readRegistry())

  useEffect(() => {
    const onStorage = () => setEntries(readRegistry())
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const add = useCallback((entry: Omit<MultisigRegistryEntry, 'addedAt'>) => {
    setEntries((current) => {
      const next = [
        ...current.filter((item) => !(item.pda === entry.pda && item.networkId === entry.networkId)),
        { ...entry, addedAt: Date.now() },
      ]
      writeRegistry(next)
      return next
    })
  }, [])

  const remove = useCallback((pda: Address, entryNetworkId: string) => {
    setEntries((current) => {
      const next = current.filter((item) => !(item.pda === pda && item.networkId === entryNetworkId))
      writeRegistry(next)
      return next
    })
  }, [])

  return { add, entries: entries.filter((entry) => entry.networkId === networkId), remove }
}
