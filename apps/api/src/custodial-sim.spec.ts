// cspell:ignore unstub
import {
  address,
  appendTransactionMessageInstructions,
  type Blockhash,
  compileTransactionMessage,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase58Encoder,
  getBase64Decoder,
  getCompiledTransactionMessageEncoder,
  getTransactionEncoder,
  lamports,
  pipe,
  type ReadonlyUint8Array,
  type SignatureBytes,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type TransactionMessageBytes,
} from '@solana/kit'
import { getTransferSolInstruction } from '@solana-program/system'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assertCustodySimulation } from './custodial.js'

// Real pubkeys — values never reach the network (fetch is stubbed), they just
// need to parse as addresses.
const CUSTODY = 'Fe1RpesrtYMJdjwbNXtpVCDNpnFvk6jSic3sJd2aCBng'
const CUSTODY_ATA = 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr'
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
const SYSTEM_PROGRAM = '11111111111111111111111111111111'
const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N' as Blockhash
const custodyBytes = getBase58Encoder().encode(CUSTODY)

// SPL token account: 165 bytes, mint @0, owner @32, u64 amount @64,
// delegate @72..108, state @108 (1 = initialized, 2 = frozen),
// close authority @129..165.
function tokenAccountData({
  amount = 1000n,
  delegate = 0,
  owner,
  state = 1,
}: {
  amount?: bigint
  delegate?: number
  owner?: ReadonlyUint8Array
  state?: number
}): string {
  const bytes = new Uint8Array(165)
  if (owner) bytes.set(owner, 32)
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

// accounts[0] is always the custody wallet itself; watched ATAs follow, then
// the wire transaction's other static accounts.
const walletOk: SimAccount = { lamports: 1_000_000_000, owner: SYSTEM_PROGRAM }
const systemOk: SimAccount = { lamports: 1, owner: SYSTEM_PROGRAM }

// A real compiled+encoded v0 transaction: one SOL transfer to `destination`
// so the guard's static-account enumeration covers it.
async function wireTransfer(destination: string): Promise<string> {
  const signer = await generateKeyPairSigner()
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(signer, tx),
    (tx) =>
      appendTransactionMessageInstructions(
        [getTransferSolInstruction({ amount: lamports(1n), destination: address(destination), source: signer })],
        tx,
      ),
    (tx) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: BLOCKHASH, lastValidBlockHeight: 100n }, tx),
  )
  const messageBytes = getCompiledTransactionMessageEncoder().encode(
    compileTransactionMessage(message),
  ) as TransactionMessageBytes
  return getBase64Decoder().decode(
    getTransactionEncoder().encode({
      messageBytes,
      signatures: { [signer.address]: new Uint8Array(64) as SignatureBytes },
    }),
  )
}

const DESTINATION = '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH'
// Static accounts in the wire tx besides custody/watched: fee payer, the
// transfer destination, the system program — three post-state slots.
const staticsOk: SimAccount[] = [systemOk, systemOk, systemOk]

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
      stubRpc([walletOk, { data: [tokenAccountData({ amount: 900n }), 'base64'], owner: TOKEN_PROGRAM }, ...staticsOk])
      const wire = await wireTransfer(DESTINATION)

      // ACT & ASSERT — 100 debited, 100 allowed.
      await expect(
        assertCustodySimulation(wire, address(CUSTODY), {
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
      stubRpc([walletOk, null, ...staticsOk])
      const wire = await wireTransfer(DESTINATION)

      // ACT & ASSERT — H-1: an absent post-simulation account is a close,
      // not "unchanged".
      await expect(assertCustodySimulation(wire, address(CUSTODY), {})).rejects.toThrow(
        'closed or removed token account',
      )
    })

    it('should reject when a delegate or close authority changed', async () => {
      // ARRANGE
      expect.assertions(1)
      stubRpc([
        walletOk,
        { data: [tokenAccountData({ amount: 1000n, delegate: 1 }), 'base64'], owner: TOKEN_PROGRAM },
        ...staticsOk,
      ])
      const wire = await wireTransfer(DESTINATION)

      // ACT & ASSERT
      await expect(assertCustodySimulation(wire, address(CUSTODY), {})).rejects.toThrow('delegate or close authority')
    })

    it('should reject when the simulation froze a token account', async () => {
      // ARRANGE
      expect.assertions(1)
      stubRpc([
        walletOk,
        { data: [tokenAccountData({ amount: 1000n, state: 2 }), 'base64'], owner: TOKEN_PROGRAM },
        ...staticsOk,
      ])
      const wire = await wireTransfer(DESTINATION)

      // ACT & ASSERT
      await expect(assertCustodySimulation(wire, address(CUSTODY), {})).rejects.toThrow('froze token account')
    })

    it('should reject a debit beyond the declared bound', async () => {
      // ARRANGE
      expect.assertions(1)
      stubRpc([walletOk, { data: [tokenAccountData({ amount: 400n }), 'base64'], owner: TOKEN_PROGRAM }, ...staticsOk])
      const wire = await wireTransfer(DESTINATION)

      // ACT & ASSERT — 600 debited, 100 allowed.
      await expect(
        assertCustodySimulation(wire, address(CUSTODY), {
          maxDebits: new Map([[address(CUSTODY_ATA), 100n]]),
        }),
      ).rejects.toThrow('debits 600')
    })

    it('should reject a custody token account created mid-transaction with a delegate', async () => {
      // ARRANGE
      expect.assertions(1)
      // Static order in the wire tx: fee payer, destination, system program.
      // The destination's post-state is a token account owned by custody
      // with a planted delegate — the pre-state enumeration never saw it.
      const createdAta: SimAccount = {
        data: [tokenAccountData({ delegate: 1, owner: custodyBytes }), 'base64'],
        owner: TOKEN_PROGRAM,
      }
      stubRpc([
        walletOk,
        { data: [tokenAccountData({}), 'base64'], owner: TOKEN_PROGRAM },
        systemOk,
        createdAta,
        systemOk,
      ])
      const wire = await wireTransfer(DESTINATION)

      // ACT & ASSERT
      await expect(assertCustodySimulation(wire, address(CUSTODY), {})).rejects.toThrow('with a delegate')
    })

    it('should reject a custody token account created mid-transaction with a foreign close authority', async () => {
      // ARRANGE
      expect.assertions(1)
      const data = (() => {
        const bytes = Uint8Array.from(atob(tokenAccountData({ owner: custodyBytes })), (c) => c.charCodeAt(0))
        bytes[129] = 1 // close-authority option tag
        return btoa(String.fromCharCode(...bytes))
      })()
      stubRpc([
        walletOk,
        { data: [tokenAccountData({}), 'base64'], owner: TOKEN_PROGRAM },
        systemOk,
        { data: [data, 'base64'], owner: TOKEN_PROGRAM },
        systemOk,
      ])
      const wire = await wireTransfer(DESTINATION)

      // ACT & ASSERT
      await expect(assertCustodySimulation(wire, address(CUSTODY), {})).rejects.toThrow('close authority')
    })
  })
})
