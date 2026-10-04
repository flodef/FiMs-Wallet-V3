import { generateKeyPairSigner } from '@solana/kit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { parseSolanaPayUrl, type SolanaPayRequest, type SolanaPayTransferRequest } from '../src/solana-pay-url.ts'

function expectTransfer(result: SolanaPayRequest): SolanaPayTransferRequest {
  if (result.kind !== 'transfer') {
    throw new Error('Expected a transfer request')
  }
  return result
}

async function testAddress() {
  const signer = await generateKeyPairSigner()
  return signer.address
}

describe('solana-pay-url', () => {
  describe('expected behavior', () => {
    it('should parse a bare recipient link', async () => {
      // ARRANGE
      expect.assertions(3)
      const recipient = await testAddress()

      // ACT
      const result = parseSolanaPayUrl(`solana:${recipient}`)

      // ASSERT
      expect(result.kind).toBe('transfer')
      expect(result).toMatchObject({ recipient, references: [] })
      expect(result).not.toHaveProperty('amount')
    })

    it('should parse a full transfer link with all fields', async () => {
      // ARRANGE
      expect.assertions(6)
      const recipient = await testAddress()
      const mint = await testAddress()
      const reference = await testAddress()

      // ACT
      const result = expectTransfer(
        parseSolanaPayUrl(
          `solana:${recipient}?amount=1.5&spl-token=${mint}&reference=${reference}&label=FiMs&message=Order%2042&memo=INV-1`,
        ),
      )

      // ASSERT
      expect(result).toMatchObject({
        amount: '1.5',
        kind: 'transfer',
        label: 'FiMs',
        memo: 'INV-1',
        message: 'Order 42',
        recipient,
        splToken: mint,
      })
      expect(result.references).toEqual([reference])
      expect(result.references).toHaveLength(1)
      expect(result.kind).toBe('transfer')
      expect(result.recipient).toBe(recipient)
      expect(result).toHaveProperty('splToken')
    })

    it('should collect several reference keys', async () => {
      // ARRANGE
      expect.assertions(1)
      const recipient = await testAddress()
      const refA = await testAddress()
      const refB = await testAddress()

      // ACT
      const result = expectTransfer(parseSolanaPayUrl(`solana:${recipient}?reference=${refA}&reference=${refB}`))

      // ASSERT
      expect(result.references).toEqual([refA, refB])
    })

    it('should detect a transaction-request link', async () => {
      // ARRANGE
      expect.assertions(2)
      const link = `solana:${encodeURIComponent('https://merchant.example.com/pay?order=1')}`

      // ACT
      const result = parseSolanaPayUrl(link)

      // ASSERT
      expect(result.kind).toBe('link')
      expect(result).toMatchObject({ url: 'https://merchant.example.com/pay?order=1' })
    })
  })

  describe('unexpected behavior', () => {
    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('should throw an error when the link is empty', () => {
      // ARRANGE
      expect.assertions(1)
      const input = '   '

      // ACT & ASSERT
      expect(() => parseSolanaPayUrl(input)).toThrow()
    })

    it('should throw an error when the scheme is not solana', async () => {
      // ARRANGE
      expect.assertions(1)
      const input = `https:${await testAddress()}`

      // ACT & ASSERT
      expect(() => parseSolanaPayUrl(input)).toThrow()
    })

    it('should throw an error when the recipient is not an address', () => {
      // ARRANGE
      expect.assertions(1)
      const input = 'solana:not-an-address'

      // ACT & ASSERT
      expect(() => parseSolanaPayUrl(input)).toThrow()
    })

    it('should throw an error when the amount is invalid', async () => {
      // ARRANGE
      expect.assertions(1)
      const input = `solana:${await testAddress()}?amount=-5`

      // ACT & ASSERT
      expect(() => parseSolanaPayUrl(input)).toThrow()
    })

    it('should throw an error when a reference is not an address', async () => {
      // ARRANGE
      expect.assertions(1)
      const input = `solana:${await testAddress()}?reference=bad`

      // ACT & ASSERT
      expect(() => parseSolanaPayUrl(input)).toThrow()
    })
  })
})
