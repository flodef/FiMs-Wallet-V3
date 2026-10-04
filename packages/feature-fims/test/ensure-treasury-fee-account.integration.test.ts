import type { Address } from '@solana/kit'
import { generateKeyPairSigner } from '@solana/kit'
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token'
import { createSolanaClient } from '@workspace/solana-client/create-solana-client'
import { getAccountInfo } from '@workspace/solana-client/get-account-info'
import { getLatestBlockhash } from '@workspace/solana-client/get-latest-blockhash'
import { getTokenAccountInfo, isParsedTokenAccountData } from '@workspace/solana-client/get-token-account-info'
import { requestAirdrop } from '@workspace/solana-client/request-airdrop'
import { solToLamports } from '@workspace/solana-client/sol-to-lamports'
import { splTokenCreateTokenMint } from '@workspace/solana-client/spl-token-create-token-mint'
import { describe, expect, it } from 'vitest'
import { ensureTreasuryFeeAccount } from '../src/data-access/ensure-treasury-fee-account.ts'
import { FIMS_TREASURY_ADDRESS } from '../src/fims-constants.ts'

describe('ensure-treasury-fee-account', () => {
  describe('expected behavior', () => {
    it('should lazily create the treasury ATA and reuse it on the second call', async () => {
      // ARRANGE
      expect.assertions(5)
      const client = createSolanaClient({
        url: 'http://localhost:8899',
        urlSubscriptions: 'ws://localhost:8900',
      })
      const transactionSigner = await generateKeyPairSigner()
      await requestAirdrop(client, { address: transactionSigner.address, amount: solToLamports('1') })
      const mint = await generateKeyPairSigner()
      await splTokenCreateTokenMint(client, {
        decimals: 6,
        latestBlockhash: await getLatestBlockhash(client),
        mint,
        transactionSigner,
      })
      const [expectedAta] = await findAssociatedTokenPda({
        mint: mint.address,
        owner: FIMS_TREASURY_ADDRESS as Address,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      })

      // ACT
      const first = await ensureTreasuryFeeAccount(client, { mint: mint.address, transactionSigner })
      const second = await ensureTreasuryFeeAccount(client, { mint: mint.address, transactionSigner })

      // ASSERT
      const accountInfo = await getAccountInfo(client, { address: first })
      const tokenAccount = await getTokenAccountInfo(client, { address: first })
      expect(first).toBe(expectedAta)
      expect(second).toBe(first)
      expect(accountInfo.value).not.toBeNull()
      // fetchJsonParsedAccount already unwraps the RPC `parsed.info` envelope:
      // mint/owner sit directly on `data`.
      expect(isParsedTokenAccountData(tokenAccount.data) && tokenAccount.data.mint === mint.address).toBe(true)
      expect(isParsedTokenAccountData(tokenAccount.data) && tokenAccount.data.owner === FIMS_TREASURY_ADDRESS).toBe(
        true,
      )
    })
  })
})
