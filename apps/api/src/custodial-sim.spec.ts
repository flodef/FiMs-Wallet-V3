// cspell:ignore unstub
import { address } from '@solana/kit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assertCustodySimulation } from './custodial.js'

// Real pubkeys — values never reach the network (fetch is stubbed), they just
// need to parse as addresses.
const CUSTODY = 'Fe1RpesrtYMJdjwbNXtpVCDNpnFvk6jSic3sJd2aCBng'
const CUSTODY_ATA = 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr'
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
const SYSTEM_PROGRAM = '11111111111111111111111111111111'

// SPL token account: 165 bytes, u64 amount @64, delegate @72..108,
// state @108 (1 = initialized, 2 = frozen), close authority @129..165.
function tokenAccountData({
  amount = 1000n,
  delegate = 0,
  state = 1,
}: {
  amount?: bigint
  delegate?: number
  state?: number
}): string {
  const bytes = new Uint8Array(165)
  new DataView(bytes.buffer).setBigUint64(64, amount, true)
  bytes[72] = delegate
  bytes[108] = state
  return btoa(String.fromCharCode(...bytes))
}

interface SimAccount {
  data?: [string, string]
  lamports?: number
  owner?: string
}

function stubRpc(simAccounts: (SimAccount | null)[]) {
  const data = tokenAccountData({ amount: 1000n })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: { body?: string }) => {
      const { method, params } = JSON.parse(init?.body ?? '{}') as {
        method: string
        params?: [unknown, { programId?: string }?]
      }
      let result: unknown = null
      if (method === 'getTokenAccountsByOwner') {
        const programId = (params?.[1] as { programId?: string } | undefined)?.programId
        result = {
          value:
            programId === TOKEN_PROGRAM
              ? [{ account: { data: [data, 'base64'], owner: TOKEN_PROGRAM }, pubkey: CUSTODY_ATA }]
              : programId === TOKEN_2022_PROGRAM
                ? []
                : [],
        }
      } else if (method === 'getBalance') {
        result = { value: 1_000_000_000 }
      } else if (method === 'simulateTransaction') {
        result = { value: { accounts: simAccounts, err: null } }
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', result }), { status: 200 })
    }),
  )
}

// accounts[0] is always the custody wallet itself; watched ATAs follow.
const walletOk: SimAccount = { lamports: 1_000_000_000, owner: SYSTEM_PROGRAM }

describe('assertCustodySimulation', () => {
  beforeEach(() => {
    vi.stubEnv('SOLANA_RPC_URL', 'https://rpc.test')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  describe('expected behavior', () => {
    it('should pass when a watched account is unchanged and within the debit bound', async () => {
      // ARRANGE
      expect.assertions(1)
      stubRpc([walletOk, { data: [tokenAccountData({ amount: 900n }), 'base64'], owner: TOKEN_PROGRAM }])

      // ACT & ASSERT — 100 debited, 100 allowed.
      await expect(
        assertCustodySimulation('wire', address(CUSTODY), {
          maxDebits: new Map([[address(CUSTODY_ATA), 100n]]),
        }),
      ).resolves.toBeUndefined()
    })
  })

  describe('unexpected behavior', () => {
    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('should reject when the simulation closed a watched token account', async () => {
      // ARRANGE
      expect.assertions(1)
      stubRpc([walletOk, null])

      // ACT & ASSERT — H-1: an absent post-simulation account is a close,
      // not "unchanged".
      await expect(assertCustodySimulation('wire', address(CUSTODY), {})).rejects.toThrow(
        'closed or removed token account',
      )
    })

    it('should reject when a delegate or close authority changed', async () => {
      // ARRANGE
      expect.assertions(1)
      stubRpc([walletOk, { data: [tokenAccountData({ amount: 1000n, delegate: 1 }), 'base64'], owner: TOKEN_PROGRAM }])

      // ACT & ASSERT
      await expect(assertCustodySimulation('wire', address(CUSTODY), {})).rejects.toThrow('delegate or close authority')
    })

    it('should reject when the simulation froze a token account', async () => {
      // ARRANGE
      expect.assertions(1)
      stubRpc([walletOk, { data: [tokenAccountData({ amount: 1000n, state: 2 }), 'base64'], owner: TOKEN_PROGRAM }])

      // ACT & ASSERT
      await expect(assertCustodySimulation('wire', address(CUSTODY), {})).rejects.toThrow('froze token account')
    })

    it('should reject a debit beyond the declared bound', async () => {
      // ARRANGE
      expect.assertions(1)
      stubRpc([walletOk, { data: [tokenAccountData({ amount: 400n }), 'base64'], owner: TOKEN_PROGRAM }])

      // ACT & ASSERT — 600 debited, 100 allowed.
      await expect(
        assertCustodySimulation('wire', address(CUSTODY), {
          maxDebits: new Map([[address(CUSTODY_ATA), 100n]]),
        }),
      ).rejects.toThrow('debits 600')
    })
  })
})
