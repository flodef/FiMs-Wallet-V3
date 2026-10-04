import { generateKeyPairSigner } from '@solana/kit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  WALLET_TRANSFER_KIND,
  WALLET_TRANSFER_VERSION,
  type WalletTransferPayload,
  walletTransferDecode,
  walletTransferEncode,
} from '../src/wallet/wallet-transfer.ts'

async function testWalletTransferInput(): Promise<WalletTransferPayload> {
  const derived = await generateKeyPairSigner()
  const imported = await generateKeyPairSigner()
  return {
    accounts: [
      { derivationIndex: 0, name: 'Account 1', publicKey: derived.address, type: 'Derived' },
      {
        derivationIndex: 0,
        name: 'Imported 1',
        publicKey: imported.address,
        secretKey: '[1,2,3]',
        type: 'Imported',
      },
    ],
    derivationPath: "m/44'/501'/0'/0'",
    kind: WALLET_TRANSFER_KIND,
    mnemonic: 'legal winner thank year wave sausage worth useful legal winner thank yellow',
    name: 'My Wallet',
    v: WALLET_TRANSFER_VERSION,
  }
}

describe('wallet-transfer', () => {
  describe('expected behavior', () => {
    it('should round-trip a payload with a mnemonic wallet', async () => {
      // ARRANGE
      expect.assertions(1)
      const input = await testWalletTransferInput()

      // ACT
      const result = walletTransferDecode(walletTransferEncode(input))

      // ASSERT
      expect(result).toEqual(input)
    })

    it('should round-trip a payload without a mnemonic (private-key wallet)', async () => {
      // ARRANGE
      expect.assertions(1)
      const input = { ...(await testWalletTransferInput()), mnemonic: '' }

      // ACT
      const result = walletTransferDecode(walletTransferEncode(input))

      // ASSERT
      expect(result).toEqual(input)
    })

    it('should produce a url-safe payload without padding', async () => {
      // ARRANGE
      expect.assertions(2)
      const input = await testWalletTransferInput()

      // ACT
      const result = walletTransferEncode(input)

      // ASSERT
      expect(result).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(result).not.toContain('=')
    })
  })

  describe('unexpected behavior', () => {
    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('should throw an error when the code is empty', () => {
      // ARRANGE
      expect.assertions(1)
      const input = '   '

      // ACT & ASSERT
      expect(() => walletTransferDecode(input)).toThrow()
    })

    it('should throw an error when the code is not base64url json', () => {
      // ARRANGE
      expect.assertions(1)
      const input = btoa('{"kind":"other"}')

      // ACT & ASSERT
      expect(() => walletTransferDecode(input)).toThrow()
    })

    it('should throw an error when the payload misses accounts', () => {
      // ARRANGE
      expect.assertions(1)
      const input = btoa(
        JSON.stringify({
          derivationPath: '',
          kind: WALLET_TRANSFER_KIND,
          mnemonic: '',
          name: 'X',
          v: WALLET_TRANSFER_VERSION,
        }),
      )

      // ACT & ASSERT
      expect(() => walletTransferDecode(input)).toThrow()
    })
  })
})
