import { useSetting } from '@workspace/db-react/use-setting'
import { useMemo } from 'react'
import { z } from 'zod'

import type { FimsWithdrawalDestination } from '../fims-constants.ts'

const destinationSchema = z.object({
  address: z.string(),
  id: z.string(),
  name: z.string(),
  provider: z.enum(['coinbase', 'jupiter', 'nexo', 'other']),
})
const destinationsSchema = z.array(destinationSchema).max(20)

// Off-ramp list stored as JSON under `withdrawalDestinations`. Legacy
// single-address keys (withdrawExchange*/withdrawJupiterSpend) are migrated
// on first read-and-write so older installs keep working — see the settings
// page's migration effect.
export function parseWithdrawalDestinations(raw: null | string | undefined): FimsWithdrawalDestination[] {
  if (!raw) {
    return []
  }
  try {
    return destinationsSchema.parse(JSON.parse(raw))
  } catch {
    return []
  }
}

export function useWithdrawalDestinations() {
  const [raw, setRaw] = useSetting('withdrawalDestinations')
  const destinations = useMemo(() => parseWithdrawalDestinations(raw), [raw])

  async function save(list: FimsWithdrawalDestination[]) {
    await setRaw(JSON.stringify(list))
  }

  return {
    destinations,
    remove: async (id: string) => await save(destinations.filter((item) => item.id !== id)),
    // Replace the whole list — the only correct way to write several entries
    // at once (looped single writes would race on the stale snapshot).
    save,
    // Insert or replace by id — also used to append new entries.
    upsert: async (item: FimsWithdrawalDestination) =>
      await save([...destinations.filter((existing) => existing.id !== item.id), item]),
  }
}
