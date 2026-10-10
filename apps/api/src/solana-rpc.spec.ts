// cspell:ignore lamports unstub
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchDonationTransaction } from './solana-rpc.js'

const TONTINE = 'Fe1RpesrtYMJdjwbNXtpVCDNpnFvk6jSic3sJd2aCBng'
const PAYER = 'DonorWallet1111111111111111111111111111111'
const MINT = 'MintAddress111111111111111111111111111111111'

function rpcResponse(result: unknown) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', result }), { status: 200 })
}

describe('fetchDonationTransaction', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  describe('expected behavior', () => {
    it('should return the payer and SOL delta when the tontine receives lamports', async () => {
      // ARRANGE
      expect.assertions(4)
      vi.mocked(fetch).mockResolvedValueOnce(
        rpcResponse({
          blockTime: 1_700_000_000,
          meta: {
            err: null,
            postBalances: [9_000_000_000, 5_000_000_000],
            postTokenBalances: [],
            preBalances: [10_000_000_000, 4_000_000_000],
            preTokenBalances: [],
          },
          transaction: { message: { accountKeys: [{ pubkey: PAYER, signer: true }, { pubkey: TONTINE }] } },
        }),
      )

      // ACT
      const result = await fetchDonationTransaction('sig', TONTINE)

      // ASSERT
      expect(result?.payer).toBe(PAYER)
      expect(result?.deltas).toEqual([
        { amount: 1, decimals: 9, mint: 'SOL', payerSourced: true, rawAmount: 1_000_000_000n },
      ])
      expect(result?.blockTime).toEqual(new Date(1_700_000_000_000))
      expect(fetch).toHaveBeenCalledTimes(1)
    })

    it('should flag a delta funded by an unrelated wallet as not payer-sourced', async () => {
      // ARRANGE
      expect.assertions(2)
      vi.mocked(fetch).mockResolvedValueOnce(
        rpcResponse({
          blockTime: null,
          meta: {
            err: null,
            postBalances: [5_000_000_000],
            postTokenBalances: [
              {
                accountIndex: 2,
                mint: MINT,
                owner: TONTINE,
                uiTokenAmount: { amount: '1500000', decimals: 6 },
              },
            ],
            preBalances: [5_000_000_000],
            preTokenBalances: [
              {
                accountIndex: 2,
                mint: MINT,
                owner: TONTINE,
                uiTokenAmount: { amount: '500000', decimals: 6 },
              },
            ],
          },
          transaction: { message: { accountKeys: [PAYER, 'other', 'tontine-ata'] } },
        }),
      )

      // ACT
      const result = await fetchDonationTransaction('sig', TONTINE)

      // ASSERT
      expect(result?.payer).toBe(PAYER)
      expect(result?.deltas).toEqual([
        { amount: 1, decimals: 6, mint: MINT, payerSourced: false, rawAmount: 1_000_000n },
      ])
    })

    it('should mark a token delta payer-sourced when a payer-owned account shrank', async () => {
      // ARRANGE
      expect.assertions(1)
      vi.mocked(fetch).mockResolvedValueOnce(
        rpcResponse({
          blockTime: null,
          meta: {
            err: null,
            postBalances: [],
            postTokenBalances: [
              { accountIndex: 1, mint: MINT, owner: PAYER, uiTokenAmount: { amount: '0', decimals: 6 } },
              { accountIndex: 2, mint: MINT, owner: TONTINE, uiTokenAmount: { amount: '1500000', decimals: 6 } },
            ],
            preBalances: [],
            preTokenBalances: [
              { accountIndex: 1, mint: MINT, owner: PAYER, uiTokenAmount: { amount: '1500000', decimals: 6 } },
              { accountIndex: 2, mint: MINT, owner: TONTINE, uiTokenAmount: { amount: '500000', decimals: 6 } },
            ],
          },
          transaction: { message: { accountKeys: [PAYER, 'payer-ata', 'tontine-ata'] } },
        }),
      )

      // ACT
      const result = await fetchDonationTransaction('sig', TONTINE)

      // ASSERT
      expect(result?.deltas).toEqual([
        { amount: 1, decimals: 6, mint: MINT, payerSourced: true, rawAmount: 1_000_000n },
      ])
    })

    it('should sum token balance deltas of accounts owned by the tontine', async () => {
      // ARRANGE
      expect.assertions(2)
      vi.mocked(fetch).mockResolvedValueOnce(
        rpcResponse({
          blockTime: null,
          meta: {
            err: null,
            postBalances: [],
            postTokenBalances: [
              {
                accountIndex: 2,
                mint: MINT,
                owner: TONTINE,
                uiTokenAmount: { amount: '1500000', decimals: 6 },
              },
            ],
            preBalances: [],
            preTokenBalances: [
              {
                accountIndex: 2,
                mint: MINT,
                owner: TONTINE,
                uiTokenAmount: { amount: '500000', decimals: 6 },
              },
            ],
          },
          transaction: { message: { accountKeys: [PAYER, 'other', 'tontine-ata'] } },
        }),
      )

      // ACT
      const result = await fetchDonationTransaction('sig', TONTINE)

      // ASSERT
      expect(result?.payer).toBe(PAYER)
      expect(result?.deltas).toEqual([
        { amount: 1, decimals: 6, mint: MINT, payerSourced: false, rawAmount: 1_000_000n },
      ])
    })

    it('should cross-check a second provider when FIMS_VERIFY_RPC_URL is set', async () => {
      // ARRANGE
      expect.assertions(2)
      vi.stubEnv('FIMS_VERIFY_RPC_URL', 'https://verify.rpc.example')
      const body = {
        blockTime: null,
        meta: {
          err: null,
          postBalances: [],
          postTokenBalances: [
            { accountIndex: 2, mint: MINT, owner: TONTINE, uiTokenAmount: { amount: '1', decimals: 6 } },
          ],
          preBalances: [],
          preTokenBalances: [],
        },
        transaction: { message: { accountKeys: [PAYER, 'other', 'ata'] } },
      }
      vi.mocked(fetch).mockResolvedValueOnce(rpcResponse(body)).mockResolvedValueOnce(rpcResponse(body))

      // ACT
      const result = await fetchDonationTransaction('sig', TONTINE)

      // ASSERT
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(result?.deltas).toHaveLength(1)
    })

    it('should throw when the two providers disagree', async () => {
      // ARRANGE
      expect.assertions(1)
      vi.stubEnv('FIMS_VERIFY_RPC_URL', 'https://verify.rpc.example')
      vi.mocked(fetch)
        .mockResolvedValueOnce(
          rpcResponse({
            meta: {
              err: null,
              postBalances: [],
              postTokenBalances: [
                { accountIndex: 2, mint: MINT, owner: TONTINE, uiTokenAmount: { amount: '1', decimals: 6 } },
              ],
              preBalances: [],
              preTokenBalances: [],
            },
            transaction: { message: { accountKeys: [PAYER] } },
          }),
        )
        .mockResolvedValueOnce(rpcResponse(null))

      // ACT & ASSERT
      await expect(fetchDonationTransaction('sig', TONTINE)).rejects.toThrow('providers disagree')
    })

    it('should ignore token balance movements not owned by the tontine', async () => {
      // ARRANGE
      expect.assertions(1)
      vi.mocked(fetch).mockResolvedValueOnce(
        rpcResponse({
          meta: {
            err: null,
            postBalances: [],
            postTokenBalances: [
              {
                accountIndex: 1,
                mint: MINT,
                owner: 'SomeoneElse11111111111111111111111111111',
                uiTokenAmount: { amount: '9000000', decimals: 6 },
              },
            ],
            preBalances: [],
            preTokenBalances: [],
          },
          transaction: { message: { accountKeys: [PAYER] } },
        }),
      )

      // ACT
      const result = await fetchDonationTransaction('sig', TONTINE)

      // ASSERT
      expect(result?.deltas).toEqual([])
    })
  })

  describe('unexpected behavior', () => {
    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('should return null when the transaction failed on chain', async () => {
      // ARRANGE
      expect.assertions(1)
      vi.mocked(fetch).mockResolvedValueOnce(
        rpcResponse({
          meta: {
            err: { InstructionError: [0, 'Custom'] },
            postBalances: [],
            postTokenBalances: [],
            preBalances: [],
            preTokenBalances: [],
          },
          transaction: { message: { accountKeys: [PAYER] } },
        }),
      )

      // ACT
      const result = await fetchDonationTransaction('sig', TONTINE)

      // ASSERT
      expect(result).toBeNull()
    })

    it('should return null when the transaction is not found', async () => {
      // ARRANGE
      expect.assertions(1)
      vi.mocked(fetch).mockResolvedValueOnce(rpcResponse(null))

      // ACT
      const result = await fetchDonationTransaction('sig', TONTINE)

      // ASSERT
      expect(result).toBeNull()
    })

    it('should throw when the RPC responds with an error status', async () => {
      // ARRANGE
      expect.assertions(1)
      vi.mocked(fetch).mockResolvedValueOnce(new Response('rate limited', { status: 429 }))

      // ACT & ASSERT
      await expect(fetchDonationTransaction('sig', TONTINE)).rejects.toThrow('solana rpc failed: 429')
    })
  })
})
