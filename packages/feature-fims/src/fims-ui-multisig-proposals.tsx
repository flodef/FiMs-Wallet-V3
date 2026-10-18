// Proposal cards of the Squads multisig view — split out of
// fims-feature-multisig.tsx (the file exceeded ~970 lines).
import { type Address, address, isAddress } from '@solana/kit'
import { useMutation } from '@tanstack/react-query'
import type { Account } from '@workspace/db/account/account'
import type { useNetworkActive } from '@workspace/db-react/use-network-active'
import { useTranslation } from '@workspace/i18n'
import { getLatestBlockhash } from '@workspace/solana-client/get-latest-blockhash'
import { useSolanaClient } from '@workspace/solana-client-react/use-solana-client'
import { Badge } from '@workspace/ui/components/badge'
import { Button } from '@workspace/ui/components/button'
import { Input } from '@workspace/ui/components/input'
import { Label } from '@workspace/ui/components/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select'
import { UiCard } from '@workspace/ui/components/ui-card'
import { UiLoader } from '@workspace/ui/components/ui-loader'
import { toastError } from '@workspace/ui/lib/toast-error'
import { toastSuccess } from '@workspace/ui/lib/toast-success'
import { type SyntheticEvent, useId, useMemo, useState } from 'react'
import { formatSol, randomAddress, SQUADS_SOL_MINT } from './fims-multisig-helpers.ts'
import type { SquadsMultisigInfo, SquadsProposalInfo, SquadsSpendingLimitInfo } from './squads/squads.ts'
import { SquadsCostPreview } from './squads/squads-cost-preview.tsx'
import {
  buildConfigExecuteInstructions,
  buildExecuteInstructions,
  buildProposalVoteInstructions,
  buildSpendingLimitProposalInstructions,
  buildSpendingLimitUseInstructions,
  buildVaultTransferProposalInstructions,
} from './squads/squads-tx.ts'
import { useSquadsSignAndSend } from './squads/use-squads.tsx'

const STATUS_VARIANT: Record<SquadsProposalInfo['status'], 'default' | 'destructive' | 'outline' | 'secondary'> = {
  active: 'secondary',
  approved: 'default',
  cancelled: 'outline',
  draft: 'outline',
  executed: 'outline',
  rejected: 'destructive',
}

export function ProposalRow({
  account,
  network,
  onDone,
  proposal,
  threshold,
}: {
  account: Account
  network: ReturnType<typeof useNetworkActive>
  onDone: () => void
  proposal: SquadsProposalInfo & { kind: 'config' | 'unknown' | 'vault'; spendingLimitPdas: Address[] }
  threshold: number
}) {
  const { t } = useTranslation('fims')
  const { signAndSend } = useSquadsSignAndSend({ account, network })
  const me = account.publicKey as Address

  const act = useMutation({
    mutationFn: async (kind: 'approve' | 'cancel' | 'execute' | 'reject') => {
      const instructions =
        kind === 'execute'
          ? proposal.kind === 'config'
            ? buildConfigExecuteInstructions({
                member: me,
                multisigPda: proposal.multisig,
                rpcUrl: network.endpoint,
                spendingLimitPdas: proposal.spendingLimitPdas,
                transactionIndex: proposal.index,
              })
            : await buildExecuteInstructions({
                member: me,
                multisigPda: proposal.multisig,
                rpcUrl: network.endpoint,
                transactionIndex: proposal.index,
              })
          : buildProposalVoteInstructions({
              kind,
              member: me,
              multisigPda: proposal.multisig,
              transactionIndex: proposal.index,
            })
      await signAndSend(instructions)
    },
    onError: (error) => toastError(error),
    onSuccess: () => {
      toastSuccess(t(($) => $.multisigTxSent))
      onDone()
    },
  })

  const voted = [...proposal.approved, ...proposal.rejected, ...proposal.cancelled].includes(me)

  return (
    <li className="space-y-2 rounded-md border p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span>
          #{proposal.index.toString()} —{' '}
          {proposal.kind === 'vault'
            ? t(($) => $.multisigKindVault)
            : proposal.kind === 'config'
              ? t(($) => $.multisigKindConfig)
              : t(($) => $.multisigKindUnknown)}
        </span>
        <Badge variant={STATUS_VARIANT[proposal.status]}>{proposal.status}</Badge>
      </div>
      <div className="text-muted-foreground text-xs">
        {t(($) => $.multisigApprovals, { count: proposal.approved.length, threshold })}
      </div>
      <div className="flex gap-2">
        {proposal.status === 'active' && !voted ? (
          <>
            <Button disabled={act.isPending} onClick={() => act.mutate('approve')} size="sm">
              {t(($) => $.multisigApprove)}
            </Button>
            <Button disabled={act.isPending} onClick={() => act.mutate('reject')} size="sm" variant="outline">
              {t(($) => $.multisigReject)}
            </Button>
          </>
        ) : null}
        {proposal.status === 'active' && voted ? (
          <Button disabled={act.isPending} onClick={() => act.mutate('cancel')} size="sm" variant="ghost">
            {t(($) => $.multisigCancel)}
          </Button>
        ) : null}
        {proposal.status === 'approved' ? (
          <Button disabled={act.isPending} onClick={() => act.mutate('execute')} size="sm">
            {t(($) => $.multisigExecute)}
          </Button>
        ) : null}
      </div>
    </li>
  )
}

export function SpendProposalCard({
  account,
  multisigInfo,
  multisigPda,
  network,
  onDone,
  vaultPda,
}: {
  account: Account
  multisigInfo: SquadsMultisigInfo
  multisigPda: Address
  network: ReturnType<typeof useNetworkActive>
  onDone: () => void
  vaultPda: Address
}) {
  const { t } = useTranslation('fims')
  const client = useSolanaClient({ network })
  const { signAndSend } = useSquadsSignAndSend({ account, network })
  const [destination, setDestination] = useState('')
  const idSpendDest = useId()
  const idSpendAmount = useId()
  const [amount, setAmount] = useState('')

  const spendLamports = useMemo(() => {
    const sol = Number.parseFloat(amount)
    return Number.isFinite(sol) && sol > 0 ? BigInt(Math.round(sol * 1e9)) : null
  }, [amount])
  const spendValid = spendLamports != null && isAddress(destination.trim())

  const propose = useMutation({
    mutationFn: async () => {
      if (!isAddress(destination.trim())) {
        throw new Error(t(($) => $.multisigInvalidAddress))
      }
      const sol = Number.parseFloat(amount)
      if (!Number.isFinite(sol) || sol <= 0) {
        throw new Error(t(($) => $.multisigInvalidAmount))
      }
      const lamports = BigInt(Math.round(sol * 1e9))
      const latestBlockhash = await getLatestBlockhash(client)
      await signAndSend(
        buildVaultTransferProposalInstructions({
          creator: account.publicKey as Address,
          destination: address(destination.trim()),
          lamports,
          latestBlockhash: latestBlockhash.blockhash,
          multisigPda,
          transactionIndex: multisigInfo.transactionIndex + 1n,
          vaultPda,
        }),
      )
    },
    onError: (error) => toastError(error),
    onSuccess: () => {
      toastSuccess(t(($) => $.multisigTxSent))
      onDone()
    },
  })

  return (
    <UiCard title={t(($) => $.multisigSpendTitle)}>
      <form
        className="space-y-3"
        onSubmit={(event: SyntheticEvent) => {
          event.preventDefault()
          propose.mutate()
        }}
      >
        <div className="space-y-1">
          <Label htmlFor={idSpendDest}>{t(($) => $.multisigDestination)}</Label>
          <Input id={idSpendDest} onChange={(event) => setDestination(event.target.value)} value={destination} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={idSpendAmount}>{t(($) => $.multisigAmountSol)}</Label>
          <Input id={idSpendAmount} onChange={(event) => setAmount(event.target.value)} value={amount} />
        </div>
        <SquadsCostPreview
          buildInstructions={async () =>
            buildVaultTransferProposalInstructions({
              creator: account.publicKey as Address,
              destination: address(destination.trim()),
              lamports: spendLamports ?? 0n,
              latestBlockhash: (await getLatestBlockhash(client)).blockhash,
              multisigPda,
              transactionIndex: multisigInfo.transactionIndex + 1n,
              vaultPda,
            })
          }
          client={client}
          inputKey={spendValid ? `${destination.trim()}:${spendLamports}` : ''}
          payer={account.publicKey as Address}
        />
        <Button disabled={propose.isPending || !spendValid} type="submit">
          {propose.isPending ? <UiLoader /> : t(($) => $.multisigProposeButton)}
        </Button>
      </form>
    </UiCard>
  )
}

export function SpendingLimitCard({
  account,
  limits,
  loading,
  multisigInfo,
  multisigPda,
  network,
  onDone,
}: {
  account: Account
  limits: { info: SquadsSpendingLimitInfo; pda: Address }[]
  loading: boolean
  multisigInfo: SquadsMultisigInfo
  multisigPda: Address
  network: ReturnType<typeof useNetworkActive>
  onDone: () => void
}) {
  const { t } = useTranslation('fims')
  const client = useSolanaClient({ network })
  const { signAndSend } = useSquadsSignAndSend({ account, network })
  const [amount, setAmount] = useState('')
  const idLimitAmount = useId()
  const idLimitDest = useId()
  const [period, setPeriod] = useState<SquadsSpendingLimitInfo['period']>('month')
  const [destination, setDestination] = useState('')
  const previewLimitKey = useMemo(randomAddress, [])

  const limitLamports = useMemo(() => {
    const sol = Number.parseFloat(amount)
    return Number.isFinite(sol) && sol > 0 ? BigInt(Math.round(sol * 1e9)) : null
  }, [amount])
  const limitDest = destination.trim()
  const limitValid = limitLamports != null && (!limitDest || isAddress(limitDest))

  const propose = useMutation({
    mutationFn: async () => {
      const sol = Number.parseFloat(amount)
      if (!Number.isFinite(sol) || sol <= 0) {
        throw new Error(t(($) => $.multisigInvalidAmount))
      }
      const lamports = BigInt(Math.round(sol * 1e9))
      const createKey = randomAddress()
      await signAndSend(
        buildSpendingLimitProposalInstructions({
          amount: lamports,
          creator: account.publicKey as Address,
          destinations: destination.trim() && isAddress(destination.trim()) ? [address(destination.trim())] : [],
          // On-chain the spending limit must name at least one member it
          // applies to — an empty list aborts execution with EmptyMembers.
          members: multisigInfo.members.map((member) => member.key),
          mint: SQUADS_SOL_MINT,
          multisigPda,
          period,
          spendingLimitCreateKey: createKey,
          transactionIndex: multisigInfo.transactionIndex + 1n,
        }),
      )
    },
    onError: (error) => toastError(error),
    onSuccess: () => {
      toastSuccess(t(($) => $.multisigTxSent))
      onDone()
    },
  })

  return (
    <UiCard title={t(($) => $.multisigLimitTitle)}>
      {loading ? (
        <UiLoader />
      ) : limits.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t(($) => $.multisigNoLimits)}</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {limits.map((limit) => (
            <li className="flex justify-between" key={limit.pda}>
              <span>
                {formatSol(limit.info.amount)} / {t(($) => $.multisigPeriod, { period: limit.info.period })}
              </span>
              <span className="text-muted-foreground">
                {t(($) => $.multisigLimitRemaining, { amount: formatSol(limit.info.remainingAmount) })}
              </span>
            </li>
          ))}
        </ul>
      )}
      <form
        className="mt-3 space-y-3"
        onSubmit={(event: SyntheticEvent) => {
          event.preventDefault()
          propose.mutate()
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor={idLimitAmount}>{t(($) => $.multisigAmountSol)}</Label>
            <Input id={idLimitAmount} onChange={(event) => setAmount(event.target.value)} value={amount} />
          </div>
          <div className="space-y-1">
            <Label>{t(($) => $.multisigLimitPeriod)}</Label>
            <Select onValueChange={(value) => setPeriod(value as SquadsSpendingLimitInfo['period'])} value={period}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="onetime">{t(($) => $.multisigPeriodOneTime)}</SelectItem>
                <SelectItem value="day">{t(($) => $.multisigPeriodDay)}</SelectItem>
                <SelectItem value="week">{t(($) => $.multisigPeriodWeek)}</SelectItem>
                <SelectItem value="month">{t(($) => $.multisigPeriodMonth)}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor={idLimitDest}>{t(($) => $.multisigLimitDest)}</Label>
          <Input
            id={idLimitDest}
            onChange={(event) => setDestination(event.target.value)}
            placeholder={t(($) => $.multisigLimitDestHint)}
            value={destination}
          />
        </div>
        <SquadsCostPreview
          buildInstructions={() =>
            buildSpendingLimitProposalInstructions({
              amount: limitLamports ?? 0n,
              creator: account.publicKey as Address,
              destinations: limitDest && isAddress(limitDest) ? [address(limitDest)] : [],
              members: multisigInfo.members.map((member) => member.key),
              mint: SQUADS_SOL_MINT,
              multisigPda,
              period,
              spendingLimitCreateKey: previewLimitKey,
              transactionIndex: multisigInfo.transactionIndex + 1n,
            })
          }
          client={client}
          inputKey={limitValid ? `${limitLamports}:${period}:${limitDest}` : ''}
          payer={account.publicKey as Address}
        />
        <Button disabled={propose.isPending || !limitValid} type="submit">
          {propose.isPending ? <UiLoader /> : t(($) => $.multisigLimitButton)}
        </Button>
      </form>
    </UiCard>
  )
}

// Direct spends under a spending limit: no proposal, no votes — the program
// itself enforces the cap. Only SOL limits that whitelist this account count.
export function SpendViaLimitCard({
  account,
  limits,
  multisigPda,
  network,
  onDone,
}: {
  account: Account
  limits: { info: SquadsSpendingLimitInfo; pda: Address }[]
  multisigPda: Address
  network: ReturnType<typeof useNetworkActive>
  onDone: () => void
}) {
  const { t } = useTranslation('fims')
  const client = useSolanaClient({ network })
  const { signAndSend } = useSquadsSignAndSend({ account, network })
  const idUseDest = useId()
  const idUseAmount = useId()
  const [limitPda, setLimitPda] = useState('')
  const [destination, setDestination] = useState('')
  const [amount, setAmount] = useState('')

  const usable = limits.filter(
    (limit) => limit.info.mint === SQUADS_SOL_MINT && limit.info.members.includes(account.publicKey as Address),
  )
  const selected = usable.find((limit) => limit.pda === limitPda) ?? usable[0]

  const useLamports = useMemo(() => {
    const sol = Number.parseFloat(amount)
    return Number.isFinite(sol) && sol > 0 ? BigInt(Math.round(sol * 1e9)) : null
  }, [amount])
  const useValid = selected != null && useLamports != null && isAddress(destination.trim())

  const spend = useMutation({
    mutationFn: async () => {
      if (!selected || !useLamports) {
        throw new Error(t(($) => $.multisigInvalidAmount))
      }
      await signAndSend(
        buildSpendingLimitUseInstructions({
          amount: useLamports,
          destination: address(destination.trim()),
          member: account.publicKey as Address,
          multisigPda,
          spendingLimitPda: selected.pda,
          vaultIndex: selected.info.vaultIndex,
        }),
      )
    },
    onError: (error) => toastError(error),
    onSuccess: () => {
      toastSuccess(t(($) => $.multisigTxSent))
      onDone()
    },
  })

  if (usable.length === 0) {
    return null
  }

  return (
    <UiCard title={t(($) => $.multisigUseTitle)}>
      <p className="text-muted-foreground text-sm">{t(($) => $.multisigUseNote)}</p>
      <form
        className="mt-3 space-y-3"
        onSubmit={(event: SyntheticEvent) => {
          event.preventDefault()
          spend.mutate()
        }}
      >
        {usable.length > 1 ? (
          <div className="space-y-1">
            <Label>{t(($) => $.multisigUseLimit)}</Label>
            <Select onValueChange={setLimitPda} value={selected?.pda ?? ''}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {usable.map((limit) => (
                  <SelectItem key={limit.pda} value={limit.pda}>
                    {formatSol(limit.info.remainingAmount)} {t(($) => $.multisigUseRemaining)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        {selected ? (
          <p className="text-muted-foreground text-xs">
            {t(($) => $.multisigLimitRemaining, { amount: formatSol(selected.info.remainingAmount) })}
          </p>
        ) : null}
        <div className="space-y-1">
          <Label htmlFor={idUseDest}>{t(($) => $.multisigDestination)}</Label>
          <Input id={idUseDest} onChange={(event) => setDestination(event.target.value)} value={destination} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={idUseAmount}>{t(($) => $.multisigAmountSol)}</Label>
          <Input id={idUseAmount} onChange={(event) => setAmount(event.target.value)} value={amount} />
        </div>
        <SquadsCostPreview
          buildInstructions={() =>
            buildSpendingLimitUseInstructions({
              amount: useLamports ?? 0n,
              destination: address(destination.trim()),
              member: account.publicKey as Address,
              multisigPda,
              spendingLimitPda: selected?.pda ?? multisigPda,
              vaultIndex: selected?.info.vaultIndex ?? 0,
            })
          }
          client={client}
          inputKey={useValid ? `${selected?.pda}:${destination.trim()}:${useLamports}` : ''}
          payer={account.publicKey as Address}
        />
        <Button disabled={spend.isPending || !useValid} type="submit">
          {spend.isPending ? <UiLoader /> : t(($) => $.multisigUseButton)}
        </Button>
      </form>
    </UiCard>
  )
}
