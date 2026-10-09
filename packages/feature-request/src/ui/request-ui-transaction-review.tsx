import { getBase64Decoder } from '@solana/kit'
import type { SolanaSignTransactionInput } from '@solana/wallet-standard-features'
import { useQuery } from '@tanstack/react-query'
import { useNetworkActive } from '@workspace/db-react/use-network-active'
import { useTranslation } from '@workspace/i18n'
import {
  formatSimulatedTransactionChange,
  getSimulatedTransactionChangeRows,
} from '@workspace/solana-client/get-simulated-transaction-change-rows'
import { inspectWireTransaction } from '@workspace/solana-client/inspect-wire-transaction'
import { lamportsToSol } from '@workspace/solana-client/lamports-to-sol'
import { useSolanaClient } from '@workspace/solana-client-react/use-solana-client'
import { Alert, AlertDescription, AlertTitle } from '@workspace/ui/components/alert'
import { Badge } from '@workspace/ui/components/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@workspace/ui/components/table'
import { UiLoader } from '@workspace/ui/components/ui-loader'
import { UiPre } from '@workspace/ui/components/ui-pre'
import { UiWarning } from '@workspace/ui/components/ui-warning'
import { ellipsify } from '@workspace/ui/lib/ellipsify'
import { useEffect, useMemo } from 'react'
import {
  analyzeWireInspection,
  type WireInspectionWarning,
  type WireInspectionWarningId,
} from '../data-access/analyze-wire-inspection.tsx'
import { useResolveAddressLabel } from '../data-access/use-resolve-address-label.tsx'

// Decodes, simulates and analyzes a dApp-submitted transaction before the
// user signs it: programs invoked, per-account balance changes, labeled
// counterparties, and warnings for anything the wallet cannot vouch for.
// `onBlockedChange` reports whether signing must stay disabled.
export function RequestUiTransactionReview({
  input,
  onBlockedChange,
}: {
  input: SolanaSignTransactionInput
  onBlockedChange?: ((blocked: boolean) => void) | undefined
}) {
  const { t } = useTranslation('request')
  const network = useNetworkActive()
  const client = useSolanaClient({ network })
  const resolveLabel = useResolveAddressLabel()
  const signer = input.account.address

  const base64 = useMemo(() => getBase64Decoder().decode(input.transaction), [input.transaction])
  const inspection = useQuery({
    enabled: !!client,
    queryFn: () => inspectWireTransaction(client, base64),
    queryKey: ['inspect-wire-transaction', network.id, base64],
    retry: false,
  })

  const analysis = useMemo(
    () => (inspection.data ? analyzeWireInspection({ inspection: inspection.data, resolveLabel, signer }) : undefined),
    [inspection.data, resolveLabel, signer],
  )

  useEffect(() => {
    onBlockedChange?.(analysis?.blockSigning ?? false)
  }, [analysis?.blockSigning, onBlockedChange])

  if (inspection.isPending) {
    return (
      <div className="flex items-center gap-2 rounded-md border p-3 text-muted-foreground text-sm">
        <UiLoader className="size-4" />
        {t(($) => $.inspectingTransaction)}
      </div>
    )
  }

  if (inspection.isError || !inspection.data || !analysis) {
    return (
      <UiWarning>
        {t(($) => $.inspectionFailed)}
        {inspection.error ? ` ${formatInspectionError(inspection.error)}` : ''}
      </UiWarning>
    )
  }

  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="rounded-md border p-3">
        <div className="mb-1 text-muted-foreground text-xs">{t(($) => $.programsInvoked)}</div>
        <div className="flex flex-wrap gap-1">
          {analysis.programs.map((program) => (
            <Badge key={program.id} title={program.id} variant={program.name ? 'outline' : 'destructive'}>
              {program.name ?? ellipsify(program.id)}
            </Badge>
          ))}
        </div>
      </div>

      {inspection.data.simulation.status === 'success' ? (
        <RequestUiChangeRows inspection={inspection.data} resolveLabel={resolveLabel} signer={signer} />
      ) : null}

      {inspection.data.simulation.fee != null ? (
        <div className="flex items-center justify-between rounded-md border p-3">
          <span className="text-muted-foreground">{t(($) => $.networkFee)}</span>
          <span className="font-mono">{lamportsToSol(inspection.data.simulation.fee)} SOL</span>
        </div>
      ) : null}

      {analysis.counterparties.length ? (
        <div className="rounded-md border p-3">
          <div className="mb-1 text-muted-foreground text-xs">{t(($) => $.receivingAccounts)}</div>
          <ul className="space-y-1">
            {analysis.counterparties.map((counterparty) => (
              <li className="flex items-center justify-between gap-2" key={counterparty.address}>
                <span className="font-mono text-xs" title={counterparty.address}>
                  {ellipsify(counterparty.address)}
                </span>
                {counterparty.label ? (
                  <Badge variant="outline">{counterparty.label}</Badge>
                ) : (
                  <Badge variant="destructive">{t(($) => $.recipientUnknown)}</Badge>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {analysis.warnings.map((warning) => (
        <RequestUiWarning key={warning.id} warning={warning} />
      ))}
    </div>
  )
}

function RequestUiChangeRows({
  inspection,
  resolveLabel,
  signer,
}: {
  inspection: Awaited<ReturnType<typeof inspectWireTransaction>>
  resolveLabel: (address: string) => string | null
  signer: string
}) {
  const { t } = useTranslation('request')
  const rows = getSimulatedTransactionChangeRows({ simulation: inspection.simulation })
  // ATA addresses are meaningless to members — resolve each token row to the
  // wallet that owns it.
  const ownerByAccount = new Map(
    inspection.simulation.tokenBalanceChanges.map((change) => [change.account, change.owner ?? change.account]),
  )

  if (!rows.length) {
    return null
  }

  return (
    <div className="rounded-md border">
      <div className="border-b p-3 font-medium">{t(($) => $.expectedChanges)}</div>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="h-8 px-3 text-xs">{t(($) => $.changeAddress)}</TableHead>
            <TableHead className="h-8 px-3 text-xs">{t(($) => $.changeToken)}</TableHead>
            <TableHead className="h-8 px-3 text-right text-xs">{t(($) => $.changeAmount)}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const owner = row.type === 'token' ? (ownerByAccount.get(row.address) ?? row.address) : row.address
            const label = owner === signer ? t(($) => $.thisWallet) : resolveLabel(owner)
            return (
              <TableRow key={`${row.address}:${row.mint}`}>
                <TableCell className="px-3 py-2 font-mono text-xs">
                  <span title={owner}>{label ?? ellipsify(owner)}</span>
                </TableCell>
                <TableCell className="px-3 py-2 font-mono text-xs">
                  <span title={row.mint}>{row.type === 'sol' ? 'SOL' : ellipsify(row.mint)}</span>
                </TableCell>
                <TableCell className="px-3 py-2 text-right">
                  <Badge
                    className="font-mono"
                    variant={row.change > 0n ? 'success' : row.change < 0n ? 'destructive' : 'outline'}
                  >
                    {formatSimulatedTransactionChange({ change: row.change, decimals: row.decimals })}
                  </Badge>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

function RequestUiWarning({ warning }: { warning: WireInspectionWarning }) {
  const { t } = useTranslation('request')
  const messages: Record<WireInspectionWarningId, string> = {
    demoRecipient: t(($) => $.warningDemoRecipient),
    simulationFailed: t(($) => $.warningSimulationFailed),
    tokenAccountCompromised: t(($) => $.warningTokenAccountCompromised),
    unexpectedSigner: t(($) => $.warningUnexpectedSigner),
    unknownRecipient: t(($) => $.warningUnknownRecipient),
    unresolvedAccounts: t(($) => $.warningUnresolvedAccounts),
    untrustedProgram: t(($) => $.warningUntrustedProgram),
    unverifiableChanges: t(($) => $.warningUnverifiableChanges),
    walletReassigned: t(($) => $.warningWalletReassigned),
  }

  if (warning.severity === 'critical') {
    return (
      <Alert variant="destructive">
        <AlertTitle>{t(($) => $.warningCriticalTitle)}</AlertTitle>
        <AlertDescription>
          {messages[warning.id]}
          {warning.detail ? <UiPre>{warning.detail}</UiPre> : null}
        </AlertDescription>
      </Alert>
    )
  }
  return (
    <UiWarning>
      {messages[warning.id]}
      {warning.detail ? <UiPre>{warning.detail}</UiPre> : null}
    </UiWarning>
  )
}

function formatInspectionError(error: unknown): string {
  return error instanceof Error ? error.message : `${error}`
}
