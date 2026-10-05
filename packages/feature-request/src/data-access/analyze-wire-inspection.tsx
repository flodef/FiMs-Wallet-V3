import type { Address } from '@solana/kit'
import { formatSimulationFailure } from '@workspace/solana-client/format-simulation-failure'
import type { WireTransactionInspection } from '@workspace/solana-client/inspect-wire-transaction'
import { programMap } from '@workspace/solana-client/program-map'

// Turns a wire-transaction inspection into the warnings shown on the dApp
// signing prompt. Unlike assert-solana-pay-transaction-safe (Solana Pay is
// fail-closed on a fixed program list), generic dApp transactions may touch
// any program — so this surfaces warnings instead of rejecting, and only
// blocks signing when intent can literally not be verified or the wallet
// account itself is handed over.

export type WireInspectionWarningId =
  | 'simulationFailed'
  | 'unverifiableChanges'
  | 'unresolvedAccounts'
  | 'walletReassigned'
  | 'unexpectedSigner'
  | 'tokenAccountCompromised'
  | 'unknownRecipient'
  | 'untrustedProgram'

export interface WireInspectionWarning {
  id: WireInspectionWarningId
  // Optional detail rendered after the translated warning (program ids,
  // account addresses…).
  detail?: string | undefined
  severity: 'critical' | 'warning'
}

export interface WireInspectionCounterparty {
  // Owner of the account that gains value (the ATA owner for token rows).
  address: string
  // Member-facing name when the address is an own account, a bookmark, or a
  // known FiMs recipient — null means "unknown to this wallet".
  label: string | null
}

export interface WireInspectionAnalysis {
  // True = the Approve button must stay disabled: intent unverifiable or the
  // wallet account itself is reassigned by the transaction.
  blockSigning: boolean
  // Accounts gaining value whose owner is not the signer.
  counterparties: WireInspectionCounterparty[]
  // All top-level program ids with a friendly name when known.
  programs: { id: string; name: string | null }[]
  warnings: WireInspectionWarning[]
}

const SYSTEM_PROGRAM = '11111111111111111111111111111111'

export function analyzeWireInspection({
  inspection,
  resolveLabel,
  signer,
}: {
  inspection: WireTransactionInspection
  resolveLabel: (address: string) => string | null
  signer: string
}): WireInspectionAnalysis {
  const warnings: WireInspectionWarning[] = []

  if (inspection.simulation.status === 'failure') {
    warnings.push({
      detail: formatSimulationFailure(inspection.simulation.error, inspection.simulation.logs),
      id: 'simulationFailed',
      severity: 'critical',
    })
  }
  if (!inspection.simulation.accountsReliable) {
    warnings.push({ id: 'unverifiableChanges', severity: 'critical' })
  }
  if (inspection.instructions.some((ix) => ix.hasUnresolvedAccounts || !ix.programId)) {
    warnings.push({ id: 'unresolvedAccounts', severity: 'critical' })
  }
  if (inspection.simulation.walletOwnerAfter !== SYSTEM_PROGRAM) {
    warnings.push({ id: 'walletReassigned', severity: 'critical' })
  }

  const preSigned = new Set(inspection.alreadySignedBy)
  const unexpectedSigners = inspection.requiredSigners.filter((s) => s !== signer && !preSigned.has(s))
  if (unexpectedSigners.length) {
    warnings.push({ detail: unexpectedSigners.join(', '), id: 'unexpectedSigner', severity: 'critical' })
  }

  const compromisedAccounts = inspection.simulation.tokenAccounts.filter(
    (row) =>
      row.ownerBefore === signer &&
      (row.destroyed ||
        row.ownerAfter !== signer ||
        row.delegateAfter ||
        (row.closeAuthorityAfter !== undefined && row.closeAuthorityAfter !== signer)),
  )
  if (compromisedAccounts.length) {
    warnings.push({
      detail: compromisedAccounts.map((row) => row.account).join(', '),
      id: 'tokenAccountCompromised',
      severity: 'critical',
    })
  }

  const programs = inspection.programIds.map((id) => ({ id, name: programMap.get(id) ?? null }))
  const untrusted = programs.filter((program) => !program.name)
  if (untrusted.length) {
    warnings.push({
      detail: untrusted.map((program) => program.id).join(', '),
      id: 'untrustedProgram',
      severity: 'warning',
    })
  }

  // Counterparties: every account gaining value owned by someone else than
  // the signer. Token rows resolve to the ATA owner so the label lookup hits
  // the member-facing wallet, not the token account.
  const counterpartyAddresses = new Set<Address>()
  for (const change of inspection.simulation.solBalanceChanges) {
    if (change.change > 0n && change.address !== signer) {
      counterpartyAddresses.add(change.address)
    }
  }
  for (const change of inspection.simulation.tokenBalanceChanges) {
    if (change.change <= 0n) {
      continue
    }
    const owner = change.owner ?? change.account
    if (owner !== signer) {
      counterpartyAddresses.add(owner)
    }
  }
  const counterparties = [...counterpartyAddresses].map((counterpartyAddress) => ({
    address: counterpartyAddress,
    label: resolveLabel(counterpartyAddress),
  }))
  const unknown = counterparties.filter((counterparty) => !counterparty.label)
  if (unknown.length) {
    warnings.push({
      detail: unknown.map((counterparty) => counterparty.address).join(', '),
      id: 'unknownRecipient',
      severity: 'warning',
    })
  }

  return {
    blockSigning: warnings.some(
      (warning) =>
        warning.id === 'unresolvedAccounts' || warning.id === 'walletReassigned' || warning.id === 'unexpectedSigner',
    ),
    counterparties,
    programs,
    warnings,
  }
}
