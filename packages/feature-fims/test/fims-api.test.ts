// cspell:ignore unstub
import { getBase64Decoder, type KeyPairSigner } from '@solana/kit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FIMS_PAGE_SIZE, fimsGetAll, fimsSignedFetch, fimsSignedGet } from '../src/fims-api.ts'

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
    it('should sign host, method, path, timestamp and body hash with the wallet keypair', async () => {
      // ARRANGE
      expect.assertions(4)
      const signedContent = new Uint8Array(512)
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)
      const body = { label: 'test' }
      const bodyHash = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(body)))),
      )
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')

      // ACT
      const result = await fimsSignedFetch<{ ok: boolean }>(
        'https://api.example.com',
        testSigner(signedContent),
        'POST',
        '/address-book',
        body,
      )

      // ASSERT
      expect(result).toEqual({ ok: true })
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe('https://api.example.com/fims/address-book')
      const headers = init.headers as Record<string, string>
      const message = new TextDecoder().decode(signedContent.subarray(0, signedContent.indexOf(0)))
      expect(message).toBe(
        `fims-wallet-v3\napi.example.com\nPOST\n/fims/address-book\n${headers['x-fims-ts']}\n${bodyHash}`,
      )
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

describe('fims-signed-get', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('expected behavior', () => {
    it('should sign the path with its canonical query', async () => {
      // ARRANGE
      expect.assertions(2)
      const signedContents: Uint8Array[] = []
      const signer = {
        address: TEST_ADDRESS,
        signMessages: vi.fn(async (messages: readonly { content: Uint8Array }[]) => {
          signedContents.push(messages[0]?.content ?? new Uint8Array())
          return [{ [TEST_ADDRESS]: SIGNATURE_BYTES }]
        }),
        signTransactions: vi.fn(async () => []),
      } as unknown as KeyPairSigner
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })),
      )

      // ACT
      await fimsSignedGet('https://api.example.com', signer, '/users', { limit: '10', offset: '0' })

      // ASSERT
      expect(signedContents).toHaveLength(1)
      const message = new TextDecoder().decode(signedContents[0])
      expect(message).toContain('\n/fims/users?limit=10&offset=0\n')
    })

    it('should retry with the legacy path-only signature after a 401', async () => {
      // ARRANGE
      expect.assertions(3)
      const signedMessages: string[] = []
      const signer = {
        address: TEST_ADDRESS,
        signMessages: vi.fn(async (messages: readonly { content: Uint8Array }[]) => {
          signedMessages.push(new TextDecoder().decode(messages[0]?.content ?? new Uint8Array()))
          return [{ [TEST_ADDRESS]: SIGNATURE_BYTES }]
        }),
        signTransactions: vi.fn(async () => []),
      } as unknown as KeyPairSigner
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
        .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)

      // ACT
      const result = await fimsSignedGet('https://api.example.com', signer, '/users', { limit: '10' })

      // ASSERT
      expect(result).toEqual([])
      expect(signedMessages[0]).toContain('\n/fims/users?limit=10\n')
      expect(signedMessages[1]).toContain('\n/fims/users\n')
    })

    it('should not retry a 401 when the request has no query', async () => {
      // ARRANGE
      expect.assertions(2)
      const fetchMock = vi.fn(async () => new Response('unauthorized', { status: 401 }))
      vi.stubGlobal('fetch', fetchMock)

      // ACT & ASSERT
      await expect(fimsSignedGet('https://api.example.com', testSigner(), '/votes')).rejects.toThrow()
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
  })
})

describe('fims-get-all', () => {
  describe('expected behavior', () => {
    it('should collect every page until a short page is returned', async () => {
      // ARRANGE
      expect.assertions(3)
      const pages = [
        Array.from({ length: FIMS_PAGE_SIZE }, (_, index) => index),
        Array.from({ length: FIMS_PAGE_SIZE }, (_, index) => index + FIMS_PAGE_SIZE),
        [FIMS_PAGE_SIZE * 2],
      ]
      const calls: Record<string, string>[] = []
      const fetchPage = vi.fn(async (params: Record<string, string>) => {
        calls.push(params)
        return pages[calls.length - 1] ?? []
      })

      // ACT
      const result = await fimsGetAll<number>('https://api.example.com', '/prices', {}, fetchPage)

      // ASSERT
      expect(result).toHaveLength(FIMS_PAGE_SIZE * 2 + 1)
      expect(calls).toHaveLength(3)
      expect(calls[1]).toMatchObject({ limit: String(FIMS_PAGE_SIZE), offset: String(FIMS_PAGE_SIZE) })
    })

    it('should stop after the first page when the page is short', async () => {
      // ARRANGE
      expect.assertions(2)
      const fetchPage = vi.fn(async () => [1, 2, 3])

      // ACT
      const result = await fimsGetAll<number>('https://api.example.com', '/tokens', {}, fetchPage)

      // ASSERT
      expect(result).toEqual([1, 2, 3])
      expect(fetchPage).toHaveBeenCalledTimes(1)
    })
  })
})
