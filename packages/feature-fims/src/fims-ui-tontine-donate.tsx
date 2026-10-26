import type { Address } from '@solana/kit'
import { useMutation } from '@tanstack/react-query'
import type { Account } from '@workspace/db/account/account'
import { useAccountGetTransactionSigner } from '@workspace/db-react/use-account-get-transaction-signer'
import { useNetworkActive } from '@workspace/db-react/use-network-active'
import { useGetTokenBalances } from '@workspace/feature-portfolio/data-access/use-get-token-balances'
import { useTranslation } from '@workspace/i18n'
import { NATIVE_MINT } from '@workspace/solana-client/constants'
import { prepareTransactionSol } from '@workspace/solana-client/prepare-transaction-sol'
import { prepareTransactionSpl } from '@workspace/solana-client/prepare-transaction-spl'
import { sendSimulatedPreparedTransaction } from '@workspace/solana-client/send-prepared-transaction'
import { useSolanaClient } from '@workspace/solana-client-react/use-solana-client'
import { Button } from '@workspace/ui/components/button'
import { Input } from '@workspace/ui/components/input'
import { Label } from '@workspace/ui/components/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select'
import { UiCard } from '@workspace/ui/components/ui-card'
import { UiLoader } from '@workspace/ui/components/ui-loader'
import { toastError } from '@workspace/ui/lib/toast-error'
import { toastSuccess } from '@workspace/ui/lib/toast-success'
import { useMemo, useState } from 'react'
import { useFimsMember, useFimsRecordDonation } from './data-access/use-fims.tsx'
import { FIMS_KNOWN_MINTS, FIMS_TONTINE_ADDRESS } from './fims-constants.ts'
import { formatTokenUnits, parseTokenUnits } from './fims-units.ts'

// FiMs-family tokens first in the donation picker — they are the pot's
// natural assets (mint order follows the pinned list).
const PRIORITY_MINTS = [FIMS_KNOWN_MINTS['FiMs'], FIMS_KNOWN_MINTS['FSOL'], FIMS_KNOWN_MINTS['FLiP']] as const
const priorityOf = (mint: string) => {
  const index = PRIORITY_MINTS.indexOf(mint as (typeof PRIORITY_MINTS)[number])
  return index === -1 ? PRIORITY_MINTS.length : index
}

// Free tontine donation: any member can send any token to the shared pot at
// any time — the send itself is exempt from the operating fee. After the
// on-chain transfer confirms, the API verifies and records the donation so it
// counts toward the member's tontine share and voting weight.
export function FimsUiTontineDonate({ account }: { account: Account }) {
  const { t } = useTranslation('fims')
  const network = useNetworkActive()
  const { member } = useFimsMember(account.publicKey, account)
  const balances = useGetTokenBalances({ address: account.publicKey, network })
  const client = useSolanaClient({ network })
  const getTransactionSigner = useAccountGetTransactionSigner({ account })
  const recordDonation = useFimsRecordDonation(account)
  const [mint, setMint] = useState<string>('')
  const [amount, setAmount] = useState('')

  const available = useMemo(
    () => balances.filter((item) => item.balance > 0n).sort((a, b) => priorityOf(a.mint) - priorityOf(b.mint)),
    [balances],
  )
  const selected = available.find((item) => item.mint === mint)
  const canSign = account.type !== 'Watched'

  const donate = useMutation({
    mutationFn: async () => {
      if (!selected) {
        throw new Error('No token selected')
      }
      const units = parseTokenUnits(amount, selected.decimals)
      if (units <= 0n || units > selected.balance) {
        throw new Error('Invalid amount')
      }
      const transactionSigner = await getTransactionSigner()
      const destination = FIMS_TONTINE_ADDRESS as Address
      const prepared =
        selected.mint === NATIVE_MINT
          ? prepareTransactionSol({
              recipients: [{ amount: units, destination }],
              senderBalance: selected.balance,
              transactionSigner,
            })
          : await prepareTransactionSpl(client, {
              mint: selected.mint,
              recipients: [{ amount: units, destination }],
              transactionSigner,
            })
      const result = await sendSimulatedPreparedTransaction(client, prepared)
      if (!result.signature) {
        throw new Error('Donation transaction failed')
      }
      return `${result.signature}`
    },
    onError: (error) => toastError(error),
    onSuccess: async (signature) => {
      // The gift is on-chain. Recording can lag one node behind — retry once
      // before reporting, the endpoint is idempotent on the signature.
      try {
        await recordDonation.mutateAsync(signature)
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 4000))
        try {
          await recordDonation.mutateAsync(signature)
        } catch (error) {
          toastError(error)
          return
        }
      }
      toastSuccess(t(($) => $.tontineDonateSuccess))
      setAmount('')
    },
  })

  // The donation is a real on-chain gift — it only exists on mainnet.
  if (network.type !== 'solana:mainnet' || !member || !canSign) {
    return null
  }

  return (
    <UiCard title={t(($) => $.tontineDonateTitle)}>
      <div className="space-y-4">
        <p className="text-muted-foreground text-xs">{t(($) => $.tontineDonateFreeNote)}</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>{t(($) => $.tontineDonateToken)}</Label>
            <Select onValueChange={setMint} value={mint}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {available.map((item) => (
                  <SelectItem key={item.mint} value={item.mint}>
                    {item.metadata?.symbol ?? item.mint.slice(0, 8)} ({item.balanceToken})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>{t(($) => $.tontineDonateAmount)}</Label>
            <div className="flex gap-2">
              <Input inputMode="decimal" onChange={(e) => setAmount(e.target.value)} placeholder="0.0" value={amount} />
              <Button
                disabled={!selected}
                onClick={() => selected && setAmount(formatTokenUnits(selected.balance, selected.decimals))}
                variant="outline"
              >
                {t(($) => $.tontineDonateAll)}
              </Button>
            </div>
          </div>
        </div>
        <div className="flex justify-end">
          <Button disabled={!selected || !amount || donate.isPending} onClick={() => donate.mutate()}>
            {donate.isPending ? <UiLoader className="size-4" /> : null}
            {t(($) => $.tontineDonateSubmit)}
          </Button>
        </div>
      </div>
    </UiCard>
  )
}
