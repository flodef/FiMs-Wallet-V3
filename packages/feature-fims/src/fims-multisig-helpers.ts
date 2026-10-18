import type { Address } from '@solana/kit'
import { getBase58Decoder } from '@solana/kit'
import { formatLamports } from '@workspace/i18n/format'

export const SQUADS_SOL_MINT = '11111111111111111111111111111111' as Address

export function randomAddress(): Address {
  return getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(32))) as Address
}

export function formatSol(lamports: bigint): string {
  return `${formatLamports(lamports)} SOL`
}
