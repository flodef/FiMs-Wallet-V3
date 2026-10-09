// cspell:ignore unstub
import type { KeyPairSigner } from '@solana/kit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FIMS_PAGE_SIZE, fimsGetAll, fimsSignedFetch, fimsSignedGet } from '../src/fims-api.ts'

const TEST_ADDRESS = '58kZikEcpFe2TZCfiomV5vP6EenGAfPsBbKazASaHbToh'
const SIGNATURE_BYTES = new Uint8Array(64).fill(7)
const SESSION_RESPONSE = () =>
  new Response(JSON.stringify({ expiresAt: new Date(Date.now() + 86_400_000).toISOString(), token: 'tok-1' }), {
    status: 200,
  })
const isSessionCreate = (url: unknown) => String(url).endsWith('/fims/session')

function testSigner(signedContents?: Uint8Array[]): KeyPairSigner {
  return {
    address: TEST_ADDRESS,
    signMessages: vi.fn(async (messages: readonly { content: Uint8Array }[]) => {
      signedContents?.push(messages[0]?.content ?? new Uint8Array())
      return [{ [TEST_ADDRESS]: SIGNATURE_BYTES }]
    }),
    signTransactions: vi.fn(async () => []),
  } as unknown as KeyPairSigner
}

describe('fims-signed-fetch', () => {
  beforeEach(() => {
    try {
      localStorage.clear()
    } catch {
      // node env without localStorage — the module guards it too
    }
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('expected behavior', () => {
    it('should mint a SIWS session then send the bearer token', async () => {
      // ARRANGE
      expect.assertions(5)
      const signedContents: Uint8Array[] = []
      const fetchMock = vi.fn(async (url: unknown) =>
        isSessionCreate(url) ? SESSION_RESPONSE() : new Response(JSON.stringify({ ok: true }), { status: 200 }),
      )
      vi.stubGlobal('fetch', fetchMock)

      // ACT
      const result = await fimsSignedFetch<{ ok: boolean }>(
        'https://api.example.com',
        testSigner(signedContents),
        'POST',
        '/address-book',
        { label: 'test' },
      )

      // ASSERT
      expect(result).toEqual({ ok: true })
      const [sessionUrl, sessionInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(sessionUrl).toBe('https://api.example.com/fims/session')
      const siws = JSON.parse(sessionInit.body as string) as { address: string }
      expect(siws.address).toBe(TEST_ADDRESS)
      const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit]
      expect(url).toBe('https://api.example.com/fims/address-book')
      const headers = init.headers as Record<string, string>
      expect(headers['authorization']).toBe('Bearer tok-1')
    })

    it('should sign a SIWS message bound to the api host', async () => {
      // ARRANGE
      expect.assertions(1)
      const signedContents: Uint8Array[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: unknown) =>
          isSessionCreate(url) ? SESSION_RESPONSE() : new Response(JSON.stringify([]), { status: 200 }),
        ),
      )

      // ACT
      await fimsSignedGet('https://api.example.com', testSigner(signedContents), '/users')

      // ASSERT
      const message = new TextDecoder().decode(signedContents[0])
      expect(message).toContain('api.example.com wants you to sign in with your Solana account:\n')
    })

    it('should reuse a stored session without signing again', async () => {
      // ARRANGE
      const hasStorage = (() => {
        try {
          return typeof localStorage !== 'undefined'
        } catch {
          return false
        }
      })()
      expect.assertions(hasStorage ? 2 : 1)
      const signer = testSigner()
      try {
        localStorage.setItem(
          `fims.session|https://api.example.com|${TEST_ADDRESS}`,
          JSON.stringify({ expiresAt: new Date(Date.now() + 86_400_000).toISOString(), token: 'stored-tok' }),
        )
      } catch {
        // node env without localStorage — the test then exercises sign-in
      }
      const fetchMock = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)

      // ACT
      await fimsSignedGet('https://api.example.com', signer, '/users')

      // ASSERT
      if (hasStorage) {
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(signer.signMessages).not.toHaveBeenCalled()
      } else {
        expect(fetchMock).toHaveBeenCalled()
      }
    })

    it('should re-mint the session and retry once after a 401', async () => {
      // ARRANGE
      expect.assertions(3)
      const signer = testSigner()
      let sessionCalls = 0
      const fetchMock = vi.fn(async (url: unknown) => {
        if (isSessionCreate(url)) {
          sessionCalls += 1
          return SESSION_RESPONSE()
        }
        return sessionCalls < 2
          ? new Response('unauthorized', { status: 401 })
          : new Response(JSON.stringify([]), { status: 200 })
      })
      vi.stubGlobal('fetch', fetchMock)

      // ACT
      const result = await fimsSignedGet('https://api.example.com', signer, '/users')

      // ASSERT
      expect(result).toEqual([])
      expect(sessionCalls).toBe(2)
      expect(fetchMock).toHaveBeenCalledTimes(4)
    })

    it('should attach a fresh confirmation signature on member deletion', async () => {
      // ARRANGE
      expect.assertions(3)
      const signedContents: Uint8Array[] = []
      const fetchMock = vi.fn(async (url: unknown) =>
        isSessionCreate(url) ? SESSION_RESPONSE() : new Response(JSON.stringify('ok'), { status: 200 }),
      )
      vi.stubGlobal('fetch', fetchMock)

      // ACT
      await fimsSignedFetch('https://api.example.com', testSigner(signedContents), 'DELETE', '/users/42')

      // ASSERT
      const [, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit]
      const headers = init.headers as Record<string, string>
      expect(headers['x-fims-confirm-sig']).toBeDefined()
      expect(headers['x-fims-confirm-ts']).toBeDefined()
      const confirm = new TextDecoder().decode(signedContents[1])
      expect(confirm).toContain('fims-confirm\napi.example.com\nDELETE\n/fims/users/42\n')
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
        'wallet did not sign the consent message',
      )
    })

    it('should throw with the response status when the api rejects', async () => {
      // ARRANGE
      expect.assertions(1)
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: unknown) =>
          isSessionCreate(url) ? SESSION_RESPONSE() : new Response('forbidden', { status: 403 }),
        ),
      )

      // ACT & ASSERT
      await expect(
        fimsSignedFetch('https://api.example.com', testSigner(), 'DELETE', '/address-book/1'),
      ).rejects.toMatchObject({ status: 403 })
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
