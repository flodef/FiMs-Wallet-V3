import type { ChainTransaction } from '@workspace/feature-portfolio/data-access/chain-api'
import type { FimsLedgerRow } from '@workspace/feature-portfolio/data-access/chain-pnl'
import { NATIVE_MINT } from '@workspace/solana-client/constants'
import { describe, expect, it } from 'vitest'
import { computeFimsCostBasisEur, computeFimsRealizedCarve, computeFimsSendSplit } from '../src/fims-realized.ts'

const RATE = 0.1
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const FIMS_MINT = 'D84wZMJRoievKkRaquXXrYSMuU5mA46RznCSrJ9HSK1u'

function chainSwap({
  inMint,
  inAmount,
  outMint,
  outAmount,
}: {
  inMint: null | string
  inAmount: number
  outMint: null | string
  outAmount: number
}): ChainTransaction {
  return {
    description: '',
    feeSol: 0,
    signature: 'sig',
    source: null,
    timestamp: 0,
    transfers: [
      { amount: inAmount, counterparty: null, counterpartyLabel: null, direction: 'in', mint: inMint, symbol: null },
      { amount: outAmount, counterparty: null, counterpartyLabel: null, direction: 'out', mint: outMint, symbol: null },
    ],
    type: 'SWAP',
  }
}

function ledgerRow(token: string, amount: number, movement: number, type = 'conversion'): FimsLedgerRow {
  return { amount: String(amount), movement, token, type }
}

const mintBySymbol = new Map([['FiMs', FIMS_MINT]])

describe('compute-fims-realized-carve', () => {
  describe('expected behavior', () => {
    it('should carve the tontine rate of the realized gain share', () => {
      // ARRANGE — 100 units sent at 1.5 EUR, basis 1 EUR: gain 50 EUR on
      // 150 EUR of proceeds → 10% of the gain = 5 EUR ≈ 3.33 units.
      expect.assertions(1)

      // ACT
      const result = computeFimsRealizedCarve({
        amount: 100_000_000n,
        avgBuyEur: 1,
        priceEur: 1.5,
        tontineRate: RATE,
      })

      // ASSERT — floor(100 × 0.1 × (0.5/1.5) × 10^6) = 3_333_333.
      expect(result).toBe(3_333_333n)
    })

    it('should carve only on the units actually leaving a partial sale', () => {
      // ARRANGE — same position but only 10 units leave.
      expect.assertions(1)

      // ACT
      const result = computeFimsRealizedCarve({
        amount: 10_000_000n,
        avgBuyEur: 1,
        priceEur: 1.5,
        tontineRate: RATE,
      })

      // ASSERT — exactly a tenth of the full-sale carve.
      expect(result).toBe(333_333n)
    })

    it('should carve nothing when selling at or under cost', () => {
      // ARRANGE — a loss realizes no gain, and no carry-forward either.
      expect.assertions(2)

      // ACT & ASSERT
      expect(computeFimsRealizedCarve({ amount: 100_000_000n, avgBuyEur: 2, priceEur: 1.5, tontineRate: RATE })).toBe(
        0n,
      )
      expect(computeFimsRealizedCarve({ amount: 100_000_000n, avgBuyEur: 1.5, priceEur: 1.5, tontineRate: RATE })).toBe(
        0n,
      )
    })

    it('should treat an unknown basis as zero — the whole value is gain', () => {
      // ARRANGE — mint received by transfer, no priced buy anywhere.
      expect.assertions(1)

      // ACT
      const result = computeFimsRealizedCarve({
        amount: 100_000_000n,
        avgBuyEur: null,
        priceEur: 1.5,
        tontineRate: RATE,
      })

      // ASSERT — 10% of the full amount.
      expect(result).toBe(10_000_000n)
    })

    it('should carve nothing when the token has no EUR price', () => {
      // ARRANGE — an unpriced token's gain cannot be computed.
      expect.assertions(2)

      // ACT & ASSERT
      expect(computeFimsRealizedCarve({ amount: 100_000_000n, avgBuyEur: 1, priceEur: null, tontineRate: RATE })).toBe(
        0n,
      )
      expect(computeFimsRealizedCarve({ amount: 100_000_000n, avgBuyEur: null, priceEur: 0, tontineRate: RATE })).toBe(
        0n,
      )
    })
  })
})

describe('compute-fims-send-split', () => {
  describe('expected behavior', () => {
    it('should split a send into destination, operating fee and gain carve', () => {
      // ARRANGE — 1000 units at 1 EUR, basis 0.5: gain 500 EUR, carve 50,
      // then the 0.2% fee applies to the remaining 950.
      expect.assertions(3)

      // ACT
      const result = computeFimsSendSplit({
        amount: 1_000_000_000n,
        avgBuyEur: 0.5,
        feeRate: 0.002,
        priceEur: 1,
        tontineRate: RATE,
      })

      // ASSERT — tontine 50 units, fee 1.9, destination 948.1.
      expect(result.tontine).toBe(50_000_000n)
      expect(result.fee).toBe(1_900_000n)
      expect(result.destination).toBe(948_100_000n)
    })

    it('should charge only the operating fee on a sale at cost', () => {
      // ARRANGE — basis equals the current price, no gain to carve.
      expect.assertions(3)

      // ACT
      const result = computeFimsSendSplit({
        amount: 1_000_000_000n,
        avgBuyEur: 1,
        feeRate: 0.002,
        priceEur: 1,
        tontineRate: RATE,
      })

      // ASSERT
      expect(result.tontine).toBe(0n)
      expect(result.fee).toBe(2_000_000n)
      expect(result.destination).toBe(998_000_000n)
    })
  })
})

describe('compute-fims-cost-basis-eur', () => {
  describe('expected behavior', () => {
    it('should give protocol tokens their exact ledger basis', () => {
      // ARRANGE — bought 100 FiMs for 120 EUR, later 50 more for 80 EUR.
      expect.assertions(1)
      const result = computeFimsCostBasisEur({
        chainTxs: [],
        ledgerRows: [ledgerRow('FiMs', 100, 120), ledgerRow('FiMs', 50, 80)],
        mintBySymbol,
        usdPerEur: 1,
      })

      // ASSERT — weighted PRU = 200 / 150.
      expect(result.get(FIMS_MINT)).toBeCloseTo(200 / 150)
    })

    it('should exclude gifted units from the ledger basis', () => {
      // ARRANGE — 100 FiMs bought for 120 + a 10-unit donation received:
      // the gift adds quantity, not cost.
      expect.assertions(1)
      const result = computeFimsCostBasisEur({
        chainTxs: [],
        ledgerRows: [ledgerRow('FiMs', 100, 120), ledgerRow('FiMs', 10, 12, 'donation')],
        mintBySymbol,
        usdPerEur: 1,
      })

      // ASSERT — PRU stays 1.2.
      expect(result.get(FIMS_MINT)).toBeCloseTo(1.2)
    })

    it('should reconstruct the basis of other mints from stable-priced swaps', () => {
      // ARRANGE — bought 2 SOL paying 300 USDC in one swap.
      expect.assertions(1)
      const result = computeFimsCostBasisEur({
        chainTxs: [chainSwap({ inAmount: 2, inMint: null, outAmount: 300, outMint: USDC_MINT })],
        ledgerRows: [],
        mintBySymbol,
        usdPerEur: 1.2,
      })

      // ASSERT — 300 USD ≈ 250 EUR → PRU 125 EUR/SOL.
      expect(result.get('SOL')).toBeCloseTo(125)
    })

    it('should report a null basis for mints with no priced inflow', () => {
      // ARRANGE — SOL arrived by plain transfer, no swap leg priced it.
      expect.assertions(1)
      const tx: ChainTransaction = {
        description: '',
        feeSol: 0,
        signature: 's',
        source: null,
        timestamp: 0,
        transfers: [
          { amount: 1, counterparty: 'x', counterpartyLabel: null, direction: 'in', mint: null, symbol: 'SOL' },
        ],
        type: 'TRANSFER',
      }
      const result = computeFimsCostBasisEur({ chainTxs: [tx], ledgerRows: [], mintBySymbol, usdPerEur: 1 })

      // ASSERT
      expect(result.get('SOL')).toBeNull()
    })

    it('should let the ledger own a mint even when chain legs also priced it', () => {
      // ARRANGE — ledger says FiMs cost 1.2; a chain swap leg would say 5.
      expect.assertions(1)
      const result = computeFimsCostBasisEur({
        chainTxs: [chainSwap({ inAmount: 10, inMint: FIMS_MINT, outAmount: 60, outMint: USDC_MINT })],
        ledgerRows: [ledgerRow('FiMs', 100, 120)],
        mintBySymbol,
        usdPerEur: 1,
      })

      // ASSERT — the exact ledger basis wins.
      expect(result.get(FIMS_MINT)).toBeCloseTo(1.2)
    })

    it('should fold a ledger SOL row and chain SOL under one key', () => {
      // ARRANGE — the tokens table keys SOL by its wrapped mint while the
      // chain keys native SOL by 'SOL' — both mean the same asset.
      expect.assertions(2)
      const solMintBySymbol = new Map([['SOL', NATIVE_MINT]])
      const result = computeFimsCostBasisEur({
        chainTxs: [],
        ledgerRows: [ledgerRow('SOL', 2, 300)],
        mintBySymbol: solMintBySymbol,
        usdPerEur: 1,
      })

      // ASSERT — PRU 150, found under the shared 'SOL' key.
      expect(result.get('SOL')).toBeCloseTo(150)
      expect(result.get(NATIVE_MINT)).toBeUndefined()
    })
  })
})
