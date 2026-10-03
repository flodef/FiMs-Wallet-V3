import type { Address, Instruction } from '@solana/kit'
import { getWithdrawInstruction } from '@solana-program/stake'
import { getCloseAccountInstruction as getSplCloseAccountInstruction } from '@solana-program/token'
import {
  getCloseAccountInstruction as getToken2022CloseAccountInstruction,
  TOKEN_2022_PROGRAM_ADDRESS,
} from '@solana-program/token-2022'
import { useQueryClient } from '@tanstack/react-query'
import { tryCatch } from '@workspace/core/try-catch'
import { useAccountActive } from '@workspace/db-react/use-account-active'
import { useAccountGetTransactionSigner } from '@workspace/db-react/use-account-get-transaction-signer'
import { useNetworkActive } from '@workspace/db-react/use-network-active'
import { useTranslation } from '@workspace/i18n'
import { formatSimulationFailure } from '@workspace/solana-client/format-simulation-failure'
import { lamportsToSol } from '@workspace/solana-client/lamports-to-sol'
import { sendSimulatedPreparedTransaction } from '@workspace/solana-client/send-prepared-transaction'
import {
  getStakeAccountsQueryOptions,
  useGetStakeAccounts,
} from '@workspace/solana-client-react/use-get-stake-accounts'
import {
  getTokenAccountsQueryOptions,
  useGetTokenAccounts,
} from '@workspace/solana-client-react/use-get-token-accounts'
import { useSolanaClient } from '@workspace/solana-client-react/use-solana-client'
import { Button } from '@workspace/ui/components/button'
import { Checkbox } from '@workspace/ui/components/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@workspace/ui/components/dialog'
import { UiLoader } from '@workspace/ui/components/ui-loader'
import { ellipsify } from '@workspace/ui/lib/ellipsify'
import { toastError } from '@workspace/ui/lib/toast-error'
import { toastSuccess } from '@workspace/ui/lib/toast-success'
import { useEffect, useMemo, useState } from 'react'
import { reportGasTopupError } from './fims-gas-topup-store.ts'

// Empty token accounts still lock ~0.002 SOL of rent each. When the wallet
// holds any, this dialog opens once per session and offers to close them all
// (or a checked subset), returning the rent to the owner in a single
// transaction (or sequential chunks when many accounts are selected).
const MAX_CLOSE_PER_TX = 10

interface ReclaimableAccount {
  kind: 'stake' | 'token'
  lamports: bigint
  mint: Address | null
  program: Address | null
  pubkey: Address
}

export function FimsFeatureRentReclaim() {
  const { t } = useTranslation('fims')
  const account = useAccountActive()
  const network = useNetworkActive()
  const client = useSolanaClient({ network })
  const queryClient = useQueryClient()
  const tokenAccounts = useGetTokenAccounts({ address: account.publicKey, network })
  const stakeAccounts = useGetStakeAccounts({ address: account.publicKey, network })
  const getTransactionSigner = useAccountGetTransactionSigner({ account })
  const [open, setOpen] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [selected, setSelected] = useState<Set<string> | null>(null)
  const [busy, setBusy] = useState(false)

  const reclaimable = useMemo<ReclaimableAccount[]>(() => {
    const tokens = (tokenAccounts.data ?? [])
      .filter((item) => item.account.data.parsed.info.tokenAmount.amount === '0')
      .map((item) => ({
        kind: 'token' as const,
        lamports: item.account.lamports,
        mint: item.account.data.parsed.info.mint,
        program: item.account.owner,
        pubkey: item.pubkey,
      }))
    // A stake account's lamports can be withdrawn — closing it — once it is
    // uninitialized or its delegation is fully deactivated down to zero.
    const stakes = (stakeAccounts.data ?? [])
      .filter((item) => item.data.stake === null || item.data.stake.delegation.stake === '0')
      .map((item) => ({
        kind: 'stake' as const,
        lamports: item.lamports,
        mint: null,
        program: null,
        pubkey: item.pubkey,
      }))
    return [...tokens, ...stakes]
  }, [stakeAccounts.data, tokenAccounts.data])

  const checked = useMemo<ReclaimableAccount[]>(
    () => (selected === null ? reclaimable : reclaimable.filter((item) => selected.has(item.pubkey))),
    [reclaimable, selected],
  )
  const totalSol = checked.reduce((sum, item) => sum + item.lamports, 0n)

  // Auto-open once per session when reclaimable rent appears — the prompt is
  // advisory, dismissing it does not nag again until the next app load.
  useEffect(() => {
    if (!dismissed && !open && reclaimable.length > 0) {
      setOpen(true)
    }
  }, [dismissed, open, reclaimable.length])

  function toggle(pubkey: string, value: boolean) {
    setSelected((current) => {
      const next = new Set(current ?? reclaimable.map((item) => item.pubkey))
      if (value) {
        next.add(pubkey)
      } else {
        next.delete(pubkey)
      }
      return next
    })
  }

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (!next) {
      setDismissed(true)
    }
  }

  async function handleConfirm() {
    setBusy(true)
    const { data: transactionSigner, error: signerError } = await tryCatch(getTransactionSigner())
    if (signerError || !transactionSigner) {
      setBusy(false)
      toastError(t(($) => $.rentReclaimError))
      return
    }
    const instructions: Instruction[] = checked.map((item) => {
      if (item.kind === 'stake') {
        return getWithdrawInstruction({
          args: item.lamports,
          recipient: account.publicKey,
          stake: item.pubkey,
          withdrawAuthority: transactionSigner,
        })
      }
      return item.program === TOKEN_2022_PROGRAM_ADDRESS
        ? getToken2022CloseAccountInstruction({
            account: item.pubkey,
            destination: account.publicKey,
            owner: transactionSigner,
          })
        : getSplCloseAccountInstruction({
            account: item.pubkey,
            destination: account.publicKey,
            owner: transactionSigner,
          })
    })
    let lastError: string | undefined
    for (let i = 0; i < instructions.length; i += MAX_CLOSE_PER_TX) {
      const chunk = instructions.slice(i, i + MAX_CLOSE_PER_TX)
      const { data: result, error } = await tryCatch(
        sendSimulatedPreparedTransaction(client, { instructions: chunk, transactionSigner }),
      )
      if (error) {
        lastError = error.message
        break
      }
      if (result?.simulation.status === 'failure') {
        lastError = formatSimulationFailure(result.simulation.error, result.simulation.logs) || 'simulation failed'
        break
      }
    }
    setBusy(false)
    if (lastError) {
      reportGasTopupError(lastError)
      toastError(`${t(($) => $.rentReclaimError)}: ${lastError}`)
      return
    }
    toastSuccess(t(($) => $.rentReclaimSuccess, { count: checked.length }))
    setOpen(false)
    setDismissed(true)
    await queryClient.invalidateQueries({
      queryKey: getTokenAccountsQueryOptions({ address: account.publicKey, client, network }).queryKey,
    })
    await queryClient.invalidateQueries({
      queryKey: getStakeAccountsQueryOptions({ address: account.publicKey, client, network }).queryKey,
    })
  }

  if (!reclaimable.length) {
    return null
  }

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(($) => $.rentReclaimTitle)}</DialogTitle>
          <DialogDescription>
            {t(($) => $.rentReclaimDescription, { count: reclaimable.length, total: lamportsToSol(totalSol) })}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-64 space-y-2 overflow-y-auto">
          {reclaimable.map((item) => {
            const isChecked = selected === null || selected.has(item.pubkey)
            return (
              <div className="flex items-center gap-3 rounded-md border p-2 text-sm" key={item.pubkey}>
                <Checkbox
                  checked={isChecked}
                  id={`reclaim-${item.pubkey}`}
                  onCheckedChange={(value) => toggle(item.pubkey, value === true)}
                />
                <label className="flex-1 font-mono text-xs" htmlFor={`reclaim-${item.pubkey}`}>
                  {ellipsify(item.pubkey, 6, '…')}
                </label>
                <span className="text-muted-foreground text-xs">
                  {item.kind === 'stake' ? 'Stake' : item.mint ? ellipsify(item.mint, 4, '…') : ''}
                </span>
                <span className="font-medium">{lamportsToSol(item.lamports)} SOL</span>
              </div>
            )
          })}
        </div>
        <DialogFooter>
          <Button disabled={busy} onClick={() => handleOpenChange(false)} variant="outline">
            {t(($) => $.rentReclaimDismiss)}
          </Button>
          <Button disabled={busy || !checked.length} onClick={() => void handleConfirm()}>
            {busy ? <UiLoader className="size-4" /> : null}
            {t(($) => $.rentReclaimConfirm, { total: lamportsToSol(totalSol) })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
