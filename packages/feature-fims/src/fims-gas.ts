import { NATIVE_MINT } from '@workspace/solana-client/constants'
import { FIMS_SOL_GAS_RESERVE } from './fims-constants.ts'

// SOL is gas-only in this wallet: it pays network fees and account rent and
// must never appear in the swap selectors.
export function isSolGasMint(mint: string): boolean {
  return mint === NATIVE_MINT
}

// Mints allowed as a swap/limit-order leg: exactly the tokens listed in the
// FiMs spreadsheet (API) that carry a concrete on-chain mint. SOL is never
// swappable — it is gas, not an investable asset.
export function fimsSwappableMints(tokens: { address?: null | string | undefined }[] | undefined): Set<string> {
  return new Set((tokens ?? []).map((token) => token.address).filter((a): a is string => Boolean(a)))
}

// Lamports still missing to reach the gas reserve — zero when the wallet
// already holds enough SOL.
export function solGasDeficit(lamports: bigint): bigint {
  return lamports < FIMS_SOL_GAS_RESERVE ? FIMS_SOL_GAS_RESERVE - lamports : 0n
}

// Lamports above the gas reserve — the amount proposed for conversion to
// JupSOL when SOL was deposited by accident.
export function solExcessAboveReserve(lamports: bigint): bigint {
  return lamports > FIMS_SOL_GAS_RESERVE ? lamports - FIMS_SOL_GAS_RESERVE : 0n
}

// True when a transaction error looks like a SOL shortage (fee payer cannot
// cover fee + rent). Drives the gas top-up dialog.
export function isInsufficientGasError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /insufficient (lamports|funds|balance)|exceeds balance|rent|Transaction fee payer/i.test(message)
}
