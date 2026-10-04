import { AccountRole, type Address, type Instruction } from '@solana/kit'

// SPL Memo program (v1) — the program Solana Pay uses to attach a text memo
// and the request's reference public keys to a transaction. Reference keys
// are appended as read-only accounts so indexers can locate the payment.
export const MEMO_PROGRAM_ADDRESS = 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo' as Address

export function createMemoInstruction({
  memo = '',
  references = [],
}: {
  memo?: string
  references?: Address[]
}): Instruction {
  return {
    accounts: references.map((address) => ({ address, role: AccountRole.READONLY })),
    data: new TextEncoder().encode(memo),
    programAddress: MEMO_PROGRAM_ADDRESS,
  }
}
