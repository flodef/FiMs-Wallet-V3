import { z } from 'zod'
import { solanaAddressSchema } from '../solana/solana-address-schema.ts'
import { accountTypeSchema } from './account-type-schema.ts'

export const accountInternalSchema = z.object({
  createdAt: z.date(),
  derivationIndex: z.number(),
  // For 'Connected' accounts: the wallet-standard name of the external
  // wallet (e.g. 'Solflare') that owns the keys and does the signing.
  externalWallet: z.string().optional(),
  id: z.string(),
  name: z.string().trim().min(1).max(20),
  order: z.number(),
  publicKey: solanaAddressSchema,
  secretKey: z.string().optional(),
  type: accountTypeSchema,
  updatedAt: z.date(),
  walletId: z.string(),
})
