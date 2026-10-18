import 'fake-indexeddb/auto'

import { QueryClientProvider } from '@tanstack/react-query'
import { AppContextProvider } from '@workspace/context-react/app-context-provider'
import { createDbContextTest } from '@workspace/db/test-helpers'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { queryClient } from '../src/query-client.tsx'
import { useSetting } from '../src/use-setting.tsx'

// Minimal renderHook harness — @testing-library/react is not a dependency.
// The hook reads useRootLoaderData (react-router route 'root') + liveQuery.
const ctx = createDbContextTest()

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

async function renderUseSetting() {
  const seen: [null | string, (v: string) => Promise<void>][] = []
  const router = createMemoryRouter(
    [
      {
        children: [
          {
            element: <Probe onRender={(r) => seen.push(r)} />,
            index: true,
          },
        ],
        id: 'root',
        loader: async () => ({
          accounts: [],
          networks: [],
          settings: await ctx.db.settings.toArray(),
          wallets: [],
        }),
      },
    ],
    { initialEntries: ['/'] },
  )
  const container = document.createElement('div')
  document.body.append(container)
  await act(async () => {
    createRoot(container).render(
      <QueryClientProvider client={queryClient}>
        <AppContextProvider ctx={ctx}>
          <RouterProvider router={router} />
        </AppContextProvider>
      </QueryClientProvider>,
    )
  })
  return { router, seen }
}

function Probe({ onRender }: { onRender: (r: [null | string, (v: string) => Promise<void>]) => void }) {
  onRender(useSetting('activeAccountId'))
  return null
}

describe('use-setting', () => {
  beforeEach(async () => {
    await ctx.db.settings.clear()
    queryClient.clear()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('expected behavior', () => {
    it('should return null when unset, a live value after write, and a STABLE setter', async () => {
      // ARRANGE
      expect.assertions(3)
      const { router, seen } = await renderUseSetting()
      const before = seen.at(-1)
      if (!before) throw new Error('probe never rendered')
      expect(before[0]).toBeNull()

      // ACT — write through the captured setter inside the router's act env
      const setterBefore = before[1]
      await act(async () => {
        await setterBefore('networkDevnet')
        // liveQuery propagates the Dexie write on a microtask — let it flush
        await new Promise((resolve) => setTimeout(resolve, 50))
      })

      // ASSERT — the value is live AND the setter identity never changed
      const after = seen.at(-1)
      if (!after) throw new Error('probe never re-rendered')
      expect(after[0]).toBe('networkDevnet')
      expect(after[1]).toBe(setterBefore)
      void router
    })
  })
})
