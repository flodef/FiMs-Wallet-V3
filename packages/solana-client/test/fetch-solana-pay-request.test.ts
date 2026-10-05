// cspell:ignore unstub Jhbn
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchSolanaPayRequest } from '../src/fetch-solana-pay-request.ts'

const ACCOUNT = 'GyU9ZpTL3ce8kfS6XSpoiXaiiGb9svJfFEWer33SMmPS' as never
const LINK = 'https://merchant.example/pay'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

describe('fetchSolanaPayRequest', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('expected behavior', () => {
    it('should get merchant info then post the account to resolve the transaction', async () => {
      // ARRANGE
      expect.assertions(5)
      vi.mocked(fetch)
        .mockResolvedValueOnce(jsonResponse({ icon: 'https://m/i.png', label: 'Coffee' }))
        .mockResolvedValueOnce(jsonResponse({ message: 'thanks', transaction: 'dHJhbnNhY3Rpb24=' }))

      // ACT
      const result = await fetchSolanaPayRequest(LINK, ACCOUNT)

      // ASSERT
      expect(fetch).toHaveBeenNthCalledWith(1, LINK, expect.anything())
      expect(fetch).toHaveBeenNthCalledWith(
        2,
        LINK,
        expect.objectContaining({ body: JSON.stringify({ account: ACCOUNT }), method: 'POST' }),
      )
      expect(result.merchant).toEqual({ icon: 'https://m/i.png', label: 'Coffee' })
      expect(result.transaction).toBe('dHJhbnNhY3Rpb24=')
      expect(result.message).toBe('thanks')
    })

    it('should still resolve when the merchant info get fails', async () => {
      // ARRANGE
      expect.assertions(2)
      vi.mocked(fetch)
        .mockRejectedValueOnce(new Error('network down'))
        .mockResolvedValueOnce(jsonResponse({ transaction: 'dA==' }))

      // ACT
      const result = await fetchSolanaPayRequest(LINK, ACCOUNT)

      // ASSERT
      expect(result.merchant).toEqual({})
      expect(result.transaction).toBe('dA==')
    })
  })

  describe('unexpected behavior', () => {
    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('should throw when the link is not https', async () => {
      // ARRANGE
      expect.assertions(1)

      // ACT & ASSERT
      await expect(fetchSolanaPayRequest('http://merchant.example/pay', ACCOUNT)).rejects.toThrow('https')
    })

    it('should throw when the post returns no transaction', async () => {
      // ARRANGE
      expect.assertions(1)
      vi.mocked(fetch)
        .mockResolvedValueOnce(jsonResponse({}))
        .mockResolvedValueOnce(jsonResponse({ message: 'no tx here' }))

      // ACT & ASSERT
      await expect(fetchSolanaPayRequest(LINK, ACCOUNT)).rejects.toThrow('no transaction')
    })

    it('should throw when the post request fails', async () => {
      // ARRANGE
      expect.assertions(1)
      vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({})).mockResolvedValueOnce(jsonResponse({}, 500))

      // ACT & ASSERT
      await expect(fetchSolanaPayRequest(LINK, ACCOUNT)).rejects.toThrow('HTTP 500')
    })
  })
})
