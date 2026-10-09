import type {
  SolanaSignAndSendTransactionInput,
  SolanaSignInInput,
  SolanaSignMessageInput,
  SolanaSignTransactionInput,
} from '@solana/wallet-standard-features'
import type { AppContext } from '@workspace/context/app-context'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerSignService } from '../src/services/sign.ts'

const mocks = vi.hoisted(() => ({
  accountByPublicKey: vi.fn(),
  accountKeyPairForAccount: vi.fn(),
  assertIsSendableTransaction: vi.fn(),
  base58Encode: vi.fn(),
  createProxyService: vi.fn(),
  createSignInMessage: vi.fn(),
  createSolanaRpc: vi.fn(() => ({ url: 'https://api.devnet.solana.com' })),
  getAddressEncoder: vi.fn(),
  getBase58Encoder: vi.fn(),
  getDbService: vi.fn(),
  getSignatureFromTransaction: vi.fn(),
  getTransactionDecoder: vi.fn(),
  getTransactionEncoder: vi.fn(),
  grantedAddress: vi.fn(),
  networkActive: vi.fn(),
  registerService: vi.fn(),
  requireGranted: vi.fn(),
  sendTransaction: vi.fn(),
  sendTransactionWithoutConfirmingFactory: vi.fn(),
  signBytes: vi.fn(),
  signTransaction: vi.fn(),
  transactionDecode: vi.fn(),
  transactionEncode: vi.fn(),
  vaultLock: vi.fn(),
  vaultRequireWalletKey: vi.fn(),
}))

vi.mock('@solana/kit', () => ({
  address: (value: string) => value,
  assertIsSendableTransaction: mocks.assertIsSendableTransaction,
  createSolanaRpc: mocks.createSolanaRpc,
  getAddressEncoder: mocks.getAddressEncoder,
  getBase58Encoder: mocks.getBase58Encoder,
  getSignatureFromTransaction: mocks.getSignatureFromTransaction,
  getTransactionDecoder: mocks.getTransactionDecoder,
  getTransactionEncoder: mocks.getTransactionEncoder,
  sendTransactionWithoutConfirmingFactory: mocks.sendTransactionWithoutConfirmingFactory,
  signBytes: mocks.signBytes,
  signTransaction: mocks.signTransaction,
}))

vi.mock('@solana/wallet-standard-chains', () => ({
  SOLANA_CHAINS: ['solana:mainnet'],
}))

vi.mock('@solana/wallet-standard-util', () => ({
  createSignInMessage: mocks.createSignInMessage,
}))

vi.mock('@webext-core/proxy-service', () => ({
  createProxyService: mocks.createProxyService,
  registerService: mocks.registerService,
}))

vi.mock('../src/services/db.ts', () => ({
  getDbService: mocks.getDbService,
}))

vi.mock('../src/services/permissions.ts', () => ({
  grantedAddress: mocks.grantedAddress,
  requireGranted: mocks.requireGranted,
}))

const ORIGIN = 'https://dapp.example'
const activeAccount = { id: 'account-1', publicKey: 'active-public-key', walletId: 'active-wallet-id' }
const backgroundContext = {
  vault: {
    lock: mocks.vaultLock,
    requireWalletKey: mocks.vaultRequireWalletKey,
  },
} as unknown as AppContext
const decodedTransaction = { id: 'decoded-transaction' }
const encodedTransactionBytes = new Uint8Array([14, 15])
const privateKey = { id: 'private-key' } as unknown as CryptoKey
const signature = new Uint8Array([10, 11])
const signatureBytes = new Uint8Array([12, 13])
const signatureValue = 'transaction-signature'
const signedMessage = new Uint8Array([8, 9])
const signedTransaction = { id: 'signed-transaction' }
const textMessageBytes = new TextEncoder().encode('hello dapp')
const transactionBytes = new Uint8Array([5, 6])
const keyPair = { privateKey } as CryptoKeyPair
const accountInput = { account: { address: activeAccount.publicKey } as never }

describe('sign-service', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    mocks.accountByPublicKey.mockResolvedValue(activeAccount)
    mocks.accountKeyPairForAccount.mockResolvedValue(keyPair)
    mocks.base58Encode.mockReturnValue(signatureBytes)
    mocks.createSignInMessage.mockReturnValue(signedMessage)
    mocks.getAddressEncoder.mockReturnValue({ encode: () => new Uint8Array([7]) })
    mocks.getBase58Encoder.mockReturnValue({ encode: mocks.base58Encode })
    mocks.getDbService.mockReturnValue({
      account: {
        byPublicKey: mocks.accountByPublicKey,
        keyPairForAccount: mocks.accountKeyPairForAccount,
      },
      network: { active: mocks.networkActive },
    })
    mocks.getSignatureFromTransaction.mockReturnValue(signatureValue)
    mocks.getTransactionDecoder.mockReturnValue({ decode: mocks.transactionDecode })
    mocks.getTransactionEncoder.mockReturnValue({ encode: mocks.transactionEncode })
    mocks.grantedAddress.mockResolvedValue(activeAccount.publicKey)
    mocks.networkActive.mockResolvedValue({ endpoint: 'https://api.devnet.solana.com' })
    mocks.requireGranted.mockResolvedValue(undefined)
    mocks.sendTransaction.mockResolvedValue(undefined)
    mocks.sendTransactionWithoutConfirmingFactory.mockReturnValue(mocks.sendTransaction)
    mocks.signBytes.mockResolvedValue(signature)
    mocks.signTransaction.mockResolvedValue(signedTransaction)
    mocks.transactionDecode.mockReturnValue(decodedTransaction)
    mocks.transactionEncode.mockReturnValue(encodedTransactionBytes)
    mocks.vaultRequireWalletKey.mockResolvedValue({ id: 'wallet-key' })
  })

  describe('expected behavior', () => {
    it('should sign and send a transaction with the granted account on the active network', async () => {
      // ARRANGE
      expect.assertions(7)
      const service = registerSignService(backgroundContext)
      const input = { ...accountInput, transaction: transactionBytes } as unknown as SolanaSignAndSendTransactionInput

      // ACT
      const result = await service.signAndSendTransaction([input], ORIGIN)

      // ASSERT
      expect(mocks.requireGranted).toHaveBeenCalledWith(ORIGIN, activeAccount.publicKey)
      expect(mocks.accountByPublicKey).toHaveBeenCalledWith(activeAccount.publicKey)
      expect(mocks.createSolanaRpc).toHaveBeenCalledWith('https://api.devnet.solana.com')
      expect(mocks.signTransaction).toHaveBeenCalledWith([keyPair], decodedTransaction)
      expect(mocks.sendTransaction).toHaveBeenCalledWith(signedTransaction, { commitment: 'confirmed' })
      expect(mocks.vaultLock).toHaveBeenCalledTimes(1)
      expect(result).toEqual([{ signature: signatureBytes }])
    })

    it('should sign in with the granted account and the request origin host', async () => {
      // ARRANGE
      expect.assertions(5)
      const service = registerSignService(backgroundContext)
      const input = {} as SolanaSignInInput

      // ACT
      const result = await service.signIn([input], ORIGIN)

      // ASSERT
      expect(mocks.grantedAddress).toHaveBeenCalledWith(ORIGIN)
      expect(mocks.createSignInMessage).toHaveBeenCalledWith({
        address: activeAccount.publicKey,
        domain: 'dapp.example',
      })
      expect(mocks.signBytes).toHaveBeenCalledWith(privateKey, signedMessage)
      expect(mocks.vaultLock).toHaveBeenCalledTimes(1)
      expect(result[0]?.account.address).toBe(activeAccount.publicKey)
    })

    it('should sign a text message with the granted account', async () => {
      // ARRANGE
      expect.assertions(7)
      const service = registerSignService(backgroundContext)
      const input = { ...accountInput, message: textMessageBytes } as SolanaSignMessageInput

      // ACT
      const result = await service.signMessage([input], ORIGIN)

      // ASSERT
      expect(mocks.requireGranted).toHaveBeenCalledWith(ORIGIN, activeAccount.publicKey)
      expect(mocks.signBytes.mock.calls[0]?.[0]).toBe(privateKey)
      expect([...(mocks.signBytes.mock.calls[0]?.[1] as Uint8Array)]).toEqual([...textMessageBytes])
      expect(mocks.vaultLock).toHaveBeenCalledTimes(1)
      expect(result[0]?.signatureType).toBe('ed25519')
      expect([...(result[0]?.signature ?? new Uint8Array())]).toEqual([...signature])
      expect([...(result[0]?.signedMessage ?? new Uint8Array())]).toEqual([...textMessageBytes])
    })

    it('should sign a transaction with the granted account', async () => {
      // ARRANGE
      expect.assertions(4)
      const service = registerSignService(backgroundContext)
      const input = { ...accountInput, transaction: transactionBytes } as SolanaSignTransactionInput

      // ACT
      const result = await service.signTransaction([input], ORIGIN)

      // ASSERT
      expect(mocks.requireGranted).toHaveBeenCalledWith(ORIGIN, activeAccount.publicKey)
      expect(mocks.signTransaction).toHaveBeenCalledWith([keyPair], decodedTransaction)
      expect(mocks.transactionEncode).toHaveBeenCalledWith(signedTransaction)
      expect(result).toEqual([{ signedTransaction: encodedTransactionBytes }])
    })
  })

  describe('unexpected behavior', () => {
    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('should reject signing for an origin that never connected', async () => {
      // ARRANGE
      expect.assertions(3)
      mocks.requireGranted.mockRejectedValue(new Error(`origin is not connected: ${ORIGIN}`))
      const service = registerSignService(backgroundContext)
      const input = { ...accountInput, message: textMessageBytes } as SolanaSignMessageInput

      // ACT & ASSERT
      await expect(service.signMessage([input], ORIGIN)).rejects.toThrow('origin is not connected')
      expect(mocks.signBytes).not.toHaveBeenCalled()
      expect(mocks.vaultLock).toHaveBeenCalledTimes(1)
    })

    it('should reject an account that is not in the wallet', async () => {
      // ARRANGE
      expect.assertions(2)
      mocks.accountByPublicKey.mockResolvedValue(undefined)
      const service = registerSignService(backgroundContext)
      const input = { ...accountInput, message: textMessageBytes } as SolanaSignMessageInput

      // ACT & ASSERT
      await expect(service.signMessage([input], ORIGIN)).rejects.toThrow('does not belong to this wallet')
      expect(mocks.signBytes).not.toHaveBeenCalled()
    })

    it('should refuse to sign transaction bytes as a message', async () => {
      // ARRANGE
      expect.assertions(2)
      mocks.transactionDecode.mockReturnValue({ messageBytes: new Uint8Array([1]) })
      const service = registerSignService(backgroundContext)
      const input = { ...accountInput, message: transactionBytes } as SolanaSignMessageInput

      // ACT & ASSERT
      await expect(service.signMessage([input], ORIGIN)).rejects.toThrow('transaction as a message')
      expect(mocks.signBytes).not.toHaveBeenCalled()
    })

    it('should refuse to sign the wallet API authentication prefix', async () => {
      // ARRANGE
      expect.assertions(2)
      const service = registerSignService(backgroundContext)
      const input = {
        ...accountInput,
        message: new TextEncoder().encode('fims-wallet-v3\nwallet-v3.fims.fi\nPOST\n/fims/userDelete\n0\n'),
      } as SolanaSignMessageInput

      // ACT & ASSERT
      await expect(service.signMessage([input], ORIGIN)).rejects.toThrow('wallet-API authentication message')
      expect(mocks.signBytes).not.toHaveBeenCalled()
    })

    it('should refuse a sign-in domain that does not match the origin', async () => {
      // ARRANGE
      expect.assertions(2)
      const service = registerSignService(backgroundContext)
      const input = { domain: 'evil.example' } as SolanaSignInInput

      // ACT & ASSERT
      await expect(service.signIn([input], ORIGIN)).rejects.toThrow('does not match origin')
      expect(mocks.signBytes).not.toHaveBeenCalled()
    })
  })
})
