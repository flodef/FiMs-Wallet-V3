import type { MessagePartialSigner } from '@solana/kit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fimsRevokeSession, fimsSessionToken } from '../src/fims-session.ts'

// The signature round-trip is the part we control mid-flight — the test
// holds mint A's signing open while a revoke + second mint race it.
vi.mock('../src/sign-content.ts', () => ({
  sameBytes: () => true,
  signContentBytes: vi.fn(),
}))

const { signContentBytes } = await import('../src/sign-content.ts')
const sign = vi.mocked(signContentBytes)

const ENDPOINT = 'https://api.example.test'
const signer = { address: 'A'.repeat(44) } as unknown as MessagePartialSigner

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, reject, resolve }
}

describe('fims-session', () => {
  beforeEach(() => {
    sign.mockReset()
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('expected behavior', () => {
    it('should self-revoke a token minted across a revoke', async () => {
      // ARRANGE — mint A stalls at the signature prompt
      expect.assertions(4)
      const gateA = deferred<{ signature: Uint8Array; signedMessage: Uint8Array }>()
      sign
        .mockReturnValueOnce(gateA.promise)
        .mockResolvedValue({ signature: new Uint8Array(64), signedMessage: new Uint8Array(0) })
      const fetchMock = vi.mocked(fetch)
      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input)
        if (init?.method === 'DELETE') return new Response(null, { status: 204 })
        return new Response(JSON.stringify({ expiresAt: '2099-01-01', token: url.includes('first') ? 'tok' : 'tok' }), {
          status: 200,
        })
      })

      // ACT — mint A in-flight, revoke bumps the epoch, mint B lands
      const mintA = fimsSessionToken(ENDPOINT, signer)
      await fimsRevokeSession(ENDPOINT, signer.address)
      const mintB = await fimsSessionToken(ENDPOINT, signer)

      // mint A resolves LATE — across the revoke: it must self-revoke
      gateA.resolve({ signature: new Uint8Array(64), signedMessage: new Uint8Array(0) })

      // ASSERT — A throws + self-revokes server-side; B resolves fine
      await expect(mintA).rejects.toThrow('session revoked')
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/fims/session'),
        expect.objectContaining({ method: 'DELETE' }),
      )
      expect(mintB).toBeTruthy()
      expect(fetchMock.mock.calls.filter(([, i]) => i?.method === 'DELETE').length).toBeGreaterThan(0)
    })
  })
})
