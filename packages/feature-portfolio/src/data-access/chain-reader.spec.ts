import { describe, expect, it } from 'vitest'
import type { ChainTransaction } from './chain-api.ts'
import { chainTxNetAmounts, classifyChainTx } from './chain-classify.ts'
import { aggregateTokenFlows, computeTokenPnl } from './chain-pnl.ts'

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const ZEC = 'A7bdiYdS5GjqGFtxf17ppRHqu9BvAgRJVqw8ZXuJp8rv'

function tx(overrides: Partial<ChainTransaction>): ChainTransaction {
  return {
    description: '',
    feeSol: 0.000005,
    signature: 'sig',
    source: null,
    timestamp: 1_700_000_000,
    transfers: [],
    type: 'TRANSFER',
    ...overrides,
  }
}

describe('classifyChainTx', () => {
  describe('expected behavior', () => {
    it('should classify a swap from the Helius type', () => {
      // ARRANGE
      expect.assertions(1)
      const input = tx({
        transfers: [
          { amount: 10, counterparty: 'pool', counterpartyLabel: null, direction: 'out', mint: ZEC, symbol: 'ZEC' },
          { amount: 300, counterparty: 'pool', counterpartyLabel: null, direction: 'in', mint: USDC, symbol: 'USDC' },
        ],
        type: 'SWAP',
      })

      // ACT
      const result = classifyChainTx(input)

      // ASSERT
      expect(result).toBe('swap')
    })

    it('should classify an outgoing transfer to the tontine as a donation', () => {
      // ARRANGE
      expect.assertions(1)
      const input = tx({
        transfers: [
          {
            amount: 2.52,
            counterparty: 'Fe1RpesrtYMJdjwbNXtpVCDNpnFvk6jSic3sJd2aCBng',
            counterpartyLabel: 'Tontine',
            direction: 'out',
            mint: 'fsol',
            symbol: 'FSOL',
          },
        ],
      })

      // ACT
      const result = classifyChainTx(input)

      // ASSERT
      expect(result).toBe('donation')
    })

    it('should classify inbound-only and outbound-only transfers', () => {
      // ARRANGE
      expect.assertions(2)
      const inbound = tx({
        transfers: [
          { amount: 5, counterparty: 'x', counterpartyLabel: 'Bloopsy', direction: 'in', mint: ZEC, symbol: 'ZEC' },
        ],
      })
      const outbound = tx({
        transfers: [
          { amount: 5, counterparty: 'x', counterpartyLabel: 'Bloopsy', direction: 'out', mint: ZEC, symbol: 'ZEC' },
        ],
      })

      // ACT & ASSERT
      expect(classifyChainTx(inbound)).toBe('deposit')
      expect(classifyChainTx(outbound)).toBe('withdrawal')
    })
  })
})

describe('chainTxNetAmounts', () => {
  describe('expected behavior', () => {
    it('should net same-symbol legs per direction', () => {
      // ARRANGE
      expect.assertions(2)
      const input = tx({
        transfers: [
          { amount: 4, counterparty: 'x', counterpartyLabel: null, direction: 'in', mint: ZEC, symbol: 'ZEC' },
          { amount: 1.5, counterparty: 'y', counterpartyLabel: null, direction: 'out', mint: ZEC, symbol: 'ZEC' },
          { amount: 0.1, counterparty: 'y', counterpartyLabel: null, direction: 'out', mint: null, symbol: 'SOL' },
        ],
      })

      // ACT
      const result = chainTxNetAmounts(input)

      // ASSERT
      expect(result.find((a) => a.symbol === 'ZEC')?.amount).toBe(2.5)
      expect(result.find((a) => a.symbol === 'SOL')?.amount).toBe(-0.1)
    })
  })
})

describe('aggregateTokenFlows + computeTokenPnl', () => {
  describe('expected behavior', () => {
    it('should price swap legs against stablecoins and compute realized/unrealized P&L', () => {
      // ARRANGE
      expect.assertions(6)
      // Buy 10 ZEC for 300 USDC, sell 4 ZEC for 160 USDC, hold 6 @40.
      const input = [
        tx({
          signature: 'buy',
          transfers: [
            { amount: 10, counterparty: 'pool', counterpartyLabel: null, direction: 'in', mint: ZEC, symbol: 'ZEC' },
            {
              amount: 300,
              counterparty: 'pool',
              counterpartyLabel: null,
              direction: 'out',
              mint: USDC,
              symbol: 'USDC',
            },
          ],
          type: 'SWAP',
        }),
        tx({
          signature: 'sell',
          transfers: [
            { amount: 4, counterparty: 'pool', counterpartyLabel: null, direction: 'out', mint: ZEC, symbol: 'ZEC' },
            { amount: 160, counterparty: 'pool', counterpartyLabel: null, direction: 'in', mint: USDC, symbol: 'USDC' },
          ],
          type: 'SWAP',
        }),
      ]
      const prices = new Map([[ZEC, 40]])

      // ACT
      const flows = aggregateTokenFlows(input)
      const zec = flows.find((f) => f.mint === ZEC)
      const pnl = computeTokenPnl(flows, prices).find((p) => p.mint === ZEC)

      // ASSERT
      expect(zec?.boughtQty).toBe(10)
      expect(zec?.boughtUsd).toBe(300)
      expect(zec?.soldUsd).toBe(160)
      expect(pnl?.netQty).toBe(6)
      // avg buy 30 — realized on 4 sold at 160 = 160 - 120
      expect(pnl?.realizedUsd).toBe(40)
      // held 6 @40 = 240 − remaining basis 6×30 = 60
      expect(pnl?.unrealizedUsd).toBe(60)
    })

    it('should leave plain transfers unpriced', () => {
      // ARRANGE
      expect.assertions(3)
      const input = [
        tx({
          transfers: [
            {
              amount: 5,
              counterparty: 'cex',
              counterpartyLabel: 'Coinbase',
              direction: 'in',
              mint: ZEC,
              symbol: 'ZEC',
            },
          ],
        }),
      ]

      // ACT
      const flows = aggregateTokenFlows(input)
      const pnl = computeTokenPnl(flows, new Map()).find((p) => p.mint === ZEC)

      // ASSERT
      expect(flows[0]?.qtyIn).toBe(5)
      expect(flows[0]?.boughtUsd).toBe(0)
      expect(pnl?.realizedUsd).toBeNull()
    })
  })
})
