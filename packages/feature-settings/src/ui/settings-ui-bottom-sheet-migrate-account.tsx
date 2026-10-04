import { type Address, address } from '@solana/kit'
import type { Account } from '@workspace/db/account/account'
import { useAccountsLive } from '@workspace/db-react/use-accounts-live'
import { useNetworkActive } from '@workspace/db-react/use-network-active'
import { useTranslation } from '@workspace/i18n'
import { lamportsToSol } from '@workspace/solana-client/lamports-to-sol'
import type { WalletMigrationPlan } from '@workspace/solana-client/plan-wallet-migration'
import { Button } from '@workspace/ui/components/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select'
import { UiBottomSheet } from '@workspace/ui/components/ui-bottom-sheet'
import { UiLoader } from '@workspace/ui/components/ui-loader'
import { UiWarning } from '@workspace/ui/components/ui-warning'
import { toastError } from '@workspace/ui/lib/toast-error'
import { toastSuccess } from '@workspace/ui/lib/toast-success'
import { useState } from 'react'
import { useWalletMigration, type WalletMigrationProgress } from '../data-access/use-wallet-migration.tsx'

// On-chain wallet migration: moves every token balance to a destination
// account, closes the obsolete token accounts (rent lands in the new
// wallet), and sweeps the remaining SOL — packed into as few transactions
// as possible, each simulated before sending. The source account is kept:
// only its on-chain assets move, the secret stays in the vault until the
// user deletes the account themselves.
export function SettingsUiBottomSheetMigrateAccount({
  account,
  open,
  setOpen,
}: {
  account: Account
  open: boolean
  setOpen: (value: boolean) => void
}) {
  const { t } = useTranslation('settings')
  const accounts = useAccountsLive()
  const network = useNetworkActive()
  const { execute, plan } = useWalletMigration(account, network)
  const [busy, setBusy] = useState(false)
  const [destinationId, setDestinationId] = useState('')
  const [result, setResult] = useState<null | WalletMigrationPlan>(null)
  const [progress, setProgress] = useState<null | WalletMigrationProgress>(null)
  const [done, setDone] = useState(false)

  const destinations = accounts.filter((item) => item.id !== account.id)
  const destination = destinations.find((item) => item.id === destinationId)
  const sol = (lamports: bigint) => lamportsToSol(lamports)
  const hasWork = !!result && (result.batches.length > 0 || result.movedAssets.length > 0)

  function reset() {
    setDestinationId('')
    setResult(null)
    setProgress(null)
    setDone(false)
  }

  function handleOpenChange(value: boolean) {
    if (!value) {
      reset()
    }
    setOpen(value)
  }

  async function handlePlan() {
    if (!destination) {
      return
    }
    try {
      setBusy(true)
      setResult(null)
      const planned = await plan(address(destination.publicKey) as Address)
      setResult(planned)
    } catch (error) {
      toastError(error instanceof Error ? error.message : `${error}`)
    } finally {
      setBusy(false)
    }
  }

  async function handleExecute() {
    if (!result) {
      return
    }
    try {
      setBusy(true)
      await execute({ batches: result.batches, onProgress: setProgress })
      setDone(true)
      toastSuccess(t(($) => $.migrateDone))
    } catch (error) {
      toastError(error instanceof Error ? error.message : `${error}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <UiBottomSheet
      description={t(($) => $.migrateDescription)}
      onOpenChange={handleOpenChange}
      open={open}
      title={t(($) => $.migrateTitle)}
    >
      <div className="space-y-4 px-4 pb-4">
        <div className="space-y-2">
          <p className="text-muted-foreground text-sm">{t(($) => $.migrateDestination)}</p>
          <Select
            disabled={done || busy}
            onValueChange={(value) => {
              setDestinationId(value)
              setResult(null)
            }}
            value={destinationId}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {destinations.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {result ? (
          <div className="space-y-2 rounded-md border p-3 text-sm">
            <div className="flex justify-between">
              <span>{t(($) => $.migrateAssetsMoved)}</span>
              <span>{result.movedAssets.length}</span>
            </div>
            <div className="flex justify-between">
              <span>{t(($) => $.migrateAccountsClosed)}</span>
              <span>{result.movedAssets.length + result.closedEmptyAccounts}</span>
            </div>
            <div className="flex justify-between">
              <span>{t(($) => $.migrateSolSwept)}</span>
              <span>{sol(result.solToSweep)} SOL</span>
            </div>
            <div className="flex justify-between">
              <span>{t(($) => $.migrateRentRecovered)}</span>
              <span>+{sol(result.rentToDestination)} SOL</span>
            </div>
            <div className="flex justify-between">
              <span>{t(($) => $.migrateAtaCost)}</span>
              <span>-{sol(result.estimatedNewAtaRent)} SOL</span>
            </div>
            <div className="flex justify-between">
              <span>{t(($) => $.migrateNetworkFees, { count: result.batches.length })}</span>
              <span>-{sol(result.txFeeTotal)} SOL</span>
            </div>
          </div>
        ) : null}

        {result?.insufficientSolForFees ? <UiWarning>{t(($) => $.migrateInsufficientSol)}</UiWarning> : null}

        {result && !hasWork ? <p className="text-muted-foreground text-sm">{t(($) => $.migrateNothing)}</p> : null}

        {progress && !done ? (
          <p className="text-muted-foreground text-sm">
            {t(($) => $.migrateProgress, { current: progress.current, total: progress.total })}
          </p>
        ) : null}
        {done ? <p className="text-sm">{t(($) => $.migrateDone)}</p> : null}

        <div className="flex justify-end gap-2">
          {result && hasWork && !done ? (
            <Button disabled={busy || result.insufficientSolForFees} onClick={handleExecute}>
              {busy ? <UiLoader className="size-4" /> : null}
              {t(($) => $.migrateExecute)}
            </Button>
          ) : done ? null : (
            <Button disabled={!destination || busy} onClick={handlePlan}>
              {busy ? <UiLoader className="size-4" /> : null}
              {t(($) => $.migrateReview)}
            </Button>
          )}
        </div>
      </div>
    </UiBottomSheet>
  )
}
