// cspell:ignore unstub
import { getBase64Decoder, type KeyPairSigner } from '@solana/kit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fimsSignedFetch } from '../src/fims-api.ts'

const TEST_ADDRESS = '58kZikEcpFe2TZCfiomV5vP6EenGAfPsBbKazASaHbToh'
const SIGNATURE_BYTES = new Uint8Array(64).fill(7)

function testSigner(signedContent?: Uint8Array): KeyPairSigner {
  return {
    address: TEST_ADDRESS,
    signMessages: vi.fn(async (messages: readonly { content: Uint8Array }[]) => {
      signedContent?.set(messages[0]?.content ?? new Uint8Array())
      return [{ [TEST_ADDRESS]: SIGNATURE_BYTES }]
    }),
    signTransactions: vi.fn(async () => []),
  } as unknown as KeyPairSigner
}

describe('fims-signed-fetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('expected behavior', () => {
    it('should sign the method, path and timestamp with the wallet keypair', async () => {
      // ARRANGE
      expect.assertions(4)
      const signedContent = new Uint8Array(512)
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)

      // ACT
      const result = await fimsSignedFetch<{ ok: boolean }>(
        'https://api.example.com',
        testSigner(signedContent),
        'POST',
        '/address-book',
        { label: 'test' },
      )

      // ASSERT
      expect(result).toEqual({ ok: true })
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe('https://api.example.com/fims/address-book')
      const headers = init.headers as Record<string, string>
      const message = new TextDecoder().decode(signedContent.subarray(0, signedContent.indexOf(0)))
      expect(message).toBe(`fims-wallet-v3\nPOST\n/fims/address-book\n${headers['x-fims-ts']}`)
      expect(headers['x-fims-sig']).toBe(getBase64Decoder().decode(SIGNATURE_BYTES))
    })
  })

  describe('unexpected behavior', () => {
    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('should throw when the wallet returns no signature', async () => {
      // ARRANGE
      expect.assertions(1)
      const signer = testSigner()
      vi.mocked(signer.signMessages).mockResolvedValue([{}] as never)

      // ACT & ASSERT
      await expect(fimsSignedFetch('https://api.example.com', signer, 'DELETE', '/address-book/1')).rejects.toThrow(
        'wallet did not sign the request',
      )
    })

    it('should throw with the response status when the api rejects', async () => {
      // ARRANGE
      expect.assertions(1)
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('forbidden', { status: 403 })),
      )

      // ACT & ASSERT
      await expect(
        fimsSignedFetch('https://api.example.com', testSigner(), 'DELETE', '/address-book/1'),
      ).rejects.toMatchObject({ status: 403 })
    })
  })
})
