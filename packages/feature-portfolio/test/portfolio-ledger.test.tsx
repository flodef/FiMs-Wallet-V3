import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  PortfolioLedger,
  PortfolioLedgerContext,
  type PortfolioLedgerData,
  type PortfolioLedgerSourceProps,
} from '../src/data-access/portfolio-ledger.tsx'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

async function render(node: React.ReactNode) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(node))
  return { container, root }
}

describe('portfolio-ledger', () => {
  describe('expected behavior', () => {
    it('should hand an empty ledger to the render prop without a provider', async () => {
      // ARRANGE
      expect.assertions(2)
      const seen: PortfolioLedgerData[] = []

      // ACT
      const { root } = await render(
        <PortfolioLedger address="addr" enabled>
          {(data) => {
            seen.push(data)
            return null
          }}
        </PortfolioLedger>,
      )

      // ASSERT
      expect(seen.at(-1)?.rows).toEqual([])
      expect(seen.at(-1)?.mintBySymbol.size).toBe(0)
      root.unmount()
    })

    it('should render the injected source component with the consumer props', async () => {
      // ARRANGE
      expect.assertions(3)
      const received: Omit<PortfolioLedgerSourceProps, 'children'>[] = []
      function Source({ children, ...props }: PortfolioLedgerSourceProps) {
        received.push(props)
        return <>{children({ mintBySymbol: new Map([['FiMs', 'mint']]), rows: [] })}</>
      }

      // ACT
      const { container, root } = await render(
        <PortfolioLedgerContext.Provider value={Source}>
          <PortfolioLedger address="target" enabled={false}>
            {(data) => <span>{data.mintBySymbol.get('FiMs')}</span>}
          </PortfolioLedger>
        </PortfolioLedgerContext.Provider>,
      )

      // ASSERT
      expect(received.at(-1)?.address).toBe('target')
      expect(received.at(-1)?.enabled).toBe(false)
      expect(container.textContent).toBe('mint')
      root.unmount()
    })
  })

  describe('unexpected behavior', () => {
    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('should keep rendering across re-renders with unchanged props', async () => {
      // ARRANGE — the #300 regression: an unchanged re-render must still
      // run the source (it owns hooks), never reuse a memoized result.
      expect.assertions(1)
      let renders = 0
      function Source({ children }: PortfolioLedgerSourceProps) {
        renders++
        return <>{children({ mintBySymbol: new Map(), rows: [] })}</>
      }
      const tree = (
        <PortfolioLedgerContext.Provider value={Source}>
          <PortfolioLedger address="a" enabled>
            {() => null}
          </PortfolioLedger>
        </PortfolioLedgerContext.Provider>
      )
      const { root } = await render(tree)

      // ACT
      await act(async () => root.render(tree))

      // ASSERT
      expect(renders).toBeGreaterThanOrEqual(1)
      root.unmount()
    })
  })
})
