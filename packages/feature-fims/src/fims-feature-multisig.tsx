import { type Address, address, getBase58Decoder, isAddress } from '@solana/kit'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Account } from '@workspace/db/account/account'
import { useNetworkActive } from '@workspace/db-react/use-network-active'
import { useTranslation } from '@workspace/i18n'
import { getLatestBlockhash } from '@workspace/solana-client/get-latest-blockhash'
import { lamportsToSol } from '@workspace/solana-client/lamports-to-sol'
import type { SolanaClient } from '@workspace/solana-client/solana-client'
import { useSolanaClient } from '@workspace/solana-client-react/use-solana-client'
import { Badge } from '@workspace/ui/components/badge'
import { Button } from '@workspace/ui/components/button'
import { Input } from '@workspace/ui/components/input'
import { Label } from '@workspace/ui/components/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select'
import { UiCard } from '@workspace/ui/components/ui-card'
import { UiLoader } from '@workspace/ui/components/ui-loader'
import { ellipsify } from '@workspace/ui/lib/ellipsify'
import { toastError } from '@workspace/ui/lib/toast-error'
import { toastSuccess } from '@workspace/ui/lib/toast-success'
import { type SyntheticEvent, useId, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import {
  type SquadsMultisigInfo,
  type SquadsProposalInfo,
  type SquadsSpendingLimitInfo,
  squadsMultisigPda,
  squadsVaultPda,
} from './squads/squads.ts'
import { SquadsCostPreview } from './squads/squads-cost-preview.tsx'
import {
  buildConfigExecuteInstructions,
  buildCreateMultisigInstructions,
  buildExecuteInstructions,
  buildProposalVoteInstructions,
  buildSpendingLimitProposalInstructions,
  buildVaultTransferProposalInstructions,
} from './squads/squads-tx.ts'
import { useMultisigRegistry } from './squads/use-multisig-registry.tsx'
import {
  fetchSquadsMultisig,
  fetchSquadsProgramConfig,
  fetchSquadsProposals,
  fetchSquadsSpendingLimits,
  useSquadsSignAndSend,
} from './squads/use-squads.tsx'

const SOL_MINT = 'So11111111111111111111111111111111111111112' as Address

function randomAddress(): Address {
  return getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(32))) as Address
}

function formatSol(lamports: bigint): string {
  return `${lamportsToSol(lamports)} SOL`
}

export function FimsFeatureMultisig({ account }: { account: Account }) {
  const network = useNetworkActive()
  const [searchParams, setSearchParams] = useSearchParams()
  const selected = searchParams.get('ms')

  if (selected && isAddress(selected)) {
    return (
      <MultisigDetail
        account={account}
        multisigPda={address(selected)}
        network={network}
        onBack={() => setSearchParams({})}
      />
    )
  }

  return <MultisigIndex account={account} network={network} onOpen={(pda) => setSearchParams({ ms: pda })} />
}

// ─── List & create ──────────────────────────────────────────────────────────

function MultisigIndex({
  account,
  network,
  onOpen,
}: {
  account: Account
  network: ReturnType<typeof useNetworkActive>
  onOpen: (pda: Address) => void
}) {
  const { t } = useTranslation('fims')
  const client = useSolanaClient({ network })
  const registry = useMultisigRegistry({ networkId: network.id })

  return (
    <div className="space-y-4">
      <UiCard title={t(($) => $.multisigTitle)}>
        <p className="text-muted-foreground text-sm">{t(($) => $.multisigDesc)}</p>
      </UiCard>
      {registry.entries.length === 0 ? (
        <UiCard title={t(($) => $.multisigKnown)}>
          <p className="text-muted-foreground text-sm">{t(($) => $.multisigEmpty)}</p>
        </UiCard>
      ) : (
        registry.entries.map((entry) => (
          <MultisigEntryCard client={client} entry={entry} key={entry.pda} onOpen={onOpen} onRemove={registry.remove} />
        ))
      )}
      <MultisigCreateCard account={account} client={client} network={network} onCreated={onOpen} registry={registry} />
      <MultisigAddCard network={network} onOpen={onOpen} registry={registry} />
    </div>
  )
}

function MultisigEntryCard({
  client,
  entry,
  onOpen,
  onRemove,
}: {
  client: SolanaClient
  entry: { label: string; networkId: string; pda: Address }
  onOpen: (pda: Address) => void
  onRemove: (pda: Address, networkId: string) => void
}) {
  const { t } = useTranslation('fims')
  const info = useQuery({
    queryFn: () => fetchSquadsMultisig(client, entry.pda),
    queryKey: ['squads', 'multisig', entry.pda],
    retry: false,
  })

  return (
    <UiCard
      title={
        <button className="hover:underline" onClick={() => onOpen(entry.pda)} type="button">
          {entry.label || ellipsify(entry.pda)}
        </button>
      }
    >
      {info.isLoading ? (
        <UiLoader />
      ) : !info.data ? (
        <p className="text-destructive text-sm">{t(($) => $.multisigNotFound)}</p>
      ) : (
        <div className="flex items-center justify-between gap-2 text-sm">
          <span className="text-muted-foreground">
            {t(($) => $.multisigSummary, {
              members: info.data.members.length,
              threshold: info.data.threshold,
            })}
          </span>
          <div className="flex gap-2">
            <Button onClick={() => onOpen(entry.pda)} size="sm" variant="outline">
              {t(($) => $.multisigOpen)}
            </Button>
            <Button onClick={() => onRemove(entry.pda, entry.networkId)} size="sm" variant="ghost">
              {t(($) => $.multisigRemove)}
            </Button>
          </div>
        </div>
      )}
    </UiCard>
  )
}

function MultisigCreateCard({
  account,
  client,
  network,
  onCreated,
  registry,
}: {
  account: Account
  client: SolanaClient
  network: ReturnType<typeof useNetworkActive>
  onCreated: (pda: Address) => void
  registry: ReturnType<typeof useMultisigRegistry>
}) {
  const { t } = useTranslation('fims')
  const { signAndSend } = useSquadsSignAndSend({ account, network })
  const config = useQuery({ queryFn: () => fetchSquadsProgramConfig(client), queryKey: ['squads', 'treasury'] })
  const [label, setLabel] = useState('')
  const idLabel = useId()
  const idMembers = useId()
  const idThreshold = useId()
  const [membersInput, setMembersInput] = useState('')
  const [threshold, setThreshold] = useState('2')
  const previewCreateKey = useMemo(randomAddress, [])

  const parsed = useMemo((): { error: 'address' | 'threshold' } | { members: Address[]; threshold: number } => {
    const extras = membersInput
      .split(/[\s,]+/)
      .map((item) => item.trim())
      .filter(Boolean)
    if (extras.some((member) => !isAddress(member))) {
      return { error: 'address' }
    }
    const members = [...new Set([account.publicKey as Address, ...extras.map((item) => address(item))])]
    const thresholdValue = Number.parseInt(threshold, 10)
    if (!Number.isInteger(thresholdValue) || thresholdValue < 1 || thresholdValue > members.length) {
      return { error: 'threshold' }
    }
    return { members, threshold: thresholdValue }
  }, [membersInput, threshold, account.publicKey])
  const parsedValid = 'members' in parsed ? parsed : null

  const create = useMutation({
    mutationFn: async () => {
      if ('error' in parsed) {
        throw new Error(
          parsed.error === 'address' ? t(($) => $.multisigInvalidAddress) : t(($) => $.multisigInvalidThreshold),
        )
      }
      if (!config.data) {
        throw new Error(t(($) => $.multisigNoTreasury))
      }
      const createKey = randomAddress()
      const multisigPda = squadsMultisigPda(createKey)
      await signAndSend(
        buildCreateMultisigInstructions({
          createKey,
          creator: account.publicKey as Address,
          members: parsed.members,
          multisigPda,
          threshold: parsed.threshold,
          treasury: config.data.treasury,
        }),
      )
      return { label, multisigPda }
    },
    onError: (error) => toastError(error instanceof Error ? error.message : String(error)),
    onSuccess: ({ label: createdLabel, multisigPda }) => {
      registry.add({ label: createdLabel, networkId: network.id, pda: multisigPda })
      toastSuccess(t(($) => $.multisigCreated))
      onCreated(multisigPda)
    },
  })

  return (
    <UiCard title={t(($) => $.multisigCreateTitle)}>
      <form
        className="space-y-3"
        onSubmit={(event: SyntheticEvent) => {
          event.preventDefault()
          create.mutate()
        }}
      >
        <div className="space-y-1">
          <Label htmlFor={idLabel}>{t(($) => $.multisigLabel)}</Label>
          <Input id={idLabel} onChange={(event) => setLabel(event.target.value)} value={label} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={idMembers}>{t(($) => $.multisigMembers)}</Label>
          <Input
            id={idMembers}
            onChange={(event) => setMembersInput(event.target.value)}
            placeholder={t(($) => $.multisigMembersHint)}
            value={membersInput}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={idThreshold}>{t(($) => $.multisigThreshold)}</Label>
          <Input
            id={idThreshold}
            min={1}
            onChange={(event) => setThreshold(event.target.value)}
            type="number"
            value={threshold}
          />
        </div>
        <SquadsCostPreview
          buildInstructions={() =>
            buildCreateMultisigInstructions({
              createKey: previewCreateKey,
              creator: account.publicKey as Address,
              members: parsedValid?.members ?? [],
              multisigPda: squadsMultisigPda(previewCreateKey),
              threshold: parsedValid?.threshold ?? 1,
              treasury: config.data?.treasury ?? account.publicKey,
            })
          }
          client={client}
          inputKey={parsedValid && config.data ? `${parsedValid.threshold}:${parsedValid.members.join(',')}` : ''}
          payer={account.publicKey as Address}
          protocolFee={config.data?.multisigCreationFee}
        />
        <Button disabled={create.isPending || config.isLoading || !parsedValid} type="submit">
          {create.isPending ? <UiLoader /> : t(($) => $.multisigCreateButton)}
        </Button>
      </form>
    </UiCard>
  )
}

function MultisigAddCard({
  network,
  onOpen,
  registry,
}: {
  network: ReturnType<typeof useNetworkActive>
  onOpen: (pda: Address) => void
  registry: ReturnType<typeof useMultisigRegistry>
}) {
  const { t } = useTranslation('fims')
  const [input, setInput] = useState('')
  const idAddLabel = useId()
  const idAddAddress = useId()
  const [label, setLabel] = useState('')
  const valid = isAddress(input.trim())

  return (
    <UiCard title={t(($) => $.multisigAddTitle)}>
      <form
        className="space-y-3"
        onSubmit={(event: SyntheticEvent) => {
          event.preventDefault()
          if (!valid) {
            return
          }
          const pda = address(input.trim())
          registry.add({ label, networkId: network.id, pda })
          onOpen(pda)
        }}
      >
        <div className="space-y-1">
          <Label htmlFor={idAddLabel}>{t(($) => $.multisigLabel)}</Label>
          <Input id={idAddLabel} onChange={(event) => setLabel(event.target.value)} value={label} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={idAddAddress}>{t(($) => $.multisigAddress)}</Label>
          <Input id={idAddAddress} onChange={(event) => setInput(event.target.value)} value={input} />
        </div>
        <Button disabled={!valid} type="submit">
          {t(($) => $.multisigAddButton)}
        </Button>
      </form>
    </UiCard>
  )
}

// ─── Detail ─────────────────────────────────────────────────────────────────

function MultisigDetail({
  account,
  multisigPda,
  network,
  onBack,
}: {
  account: Account
  multisigPda: Address
  network: ReturnType<typeof useNetworkActive>
  onBack: () => void
}) {
  const { t } = useTranslation('fims')
  const client = useSolanaClient({ network })
  const queryClient = useQueryClient()
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['squads', 'multisig', multisigPda] })
    void queryClient.invalidateQueries({ queryKey: ['squads', 'proposals', multisigPda] })
    void queryClient.invalidateQueries({ queryKey: ['squads', 'spending', multisigPda] })
    void queryClient.invalidateQueries({ queryKey: ['squads', 'vault-balance', multisigPda] })
  }

  const info = useQuery({
    queryFn: () => fetchSquadsMultisig(client, multisigPda),
    queryKey: ['squads', 'multisig', multisigPda],
  })
  const proposals = useQuery({
    queryFn: () => fetchSquadsProposals(client, multisigPda),
    queryKey: ['squads', 'proposals', multisigPda],
  })
  const spending = useQuery({
    queryFn: () => fetchSquadsSpendingLimits(client, multisigPda),
    queryKey: ['squads', 'spending', multisigPda],
  })
  const vaultPda = squadsVaultPda(multisigPda)
  const vaultBalance = useQuery({
    queryFn: async () => (await client.rpc.getBalance(vaultPda).send()).value,
    queryKey: ['squads', 'vault-balance', multisigPda],
  })

  if (info.isLoading) {
    return <UiLoader />
  }
  if (!info.data) {
    return (
      <UiCard title={t(($) => $.multisigTitle)}>
        <p className="text-destructive text-sm">{t(($) => $.multisigNotFound)}</p>
        <Button className="mt-3" onClick={onBack} variant="outline">
          {t(($) => $.multisigBack)}
        </Button>
      </UiCard>
    )
  }

  const multisigThreshold = info.data.threshold
  const isMember = info.data.members.some((member) => member.key === account.publicKey)

  return (
    <div className="space-y-4">
      <UiCard title={ellipsify(multisigPda, 8)}>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t(($) => $.multisigThreshold)}</span>
            <span>
              {info.data.threshold} / {info.data.members.length}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t(($) => $.multisigVault)}</span>
            <span className="font-mono text-xs">{ellipsify(vaultPda, 8)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t(($) => $.multisigVaultBalance)}</span>
            <span>{vaultBalance.data != null ? formatSol(vaultBalance.data) : '—'}</span>
          </div>
          <div>
            <span className="text-muted-foreground">{t(($) => $.multisigMembersList)}</span>
            <ul className="mt-1 space-y-1">
              {info.data.members.map((member) => (
                <li className="font-mono text-xs" key={member.key}>
                  {ellipsify(member.key, 8)}
                  {member.key === account.publicKey ? ` ${t(($) => $.multisigYou)}` : ''}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </UiCard>

      <UiCard title={t(($) => $.multisigProposals)}>
        {proposals.isLoading ? (
          <UiLoader />
        ) : !proposals.data?.length ? (
          <p className="text-muted-foreground text-sm">{t(($) => $.multisigNoProposals)}</p>
        ) : (
          <ul className="space-y-3">
            {proposals.data.map((proposal) => (
              <ProposalRow
                account={account}
                key={proposal.pda}
                network={network}
                onDone={refresh}
                proposal={proposal}
                threshold={multisigThreshold}
              />
            ))}
          </ul>
        )}
        <p className="mt-3 text-muted-foreground text-xs">{t(($) => $.multisigVoteCost)}</p>
      </UiCard>

      {isMember ? (
        <>
          <SpendProposalCard
            account={account}
            multisigInfo={info.data}
            multisigPda={multisigPda}
            network={network}
            onDone={refresh}
            vaultPda={vaultPda}
          />
          <SpendingLimitCard
            account={account}
            limits={spending.data ?? []}
            loading={spending.isLoading}
            multisigInfo={info.data}
            multisigPda={multisigPda}
            network={network}
            onDone={refresh}
          />
        </>
      ) : null}
      <Button onClick={onBack} variant="outline">
        {t(($) => $.multisigBack)}
      </Button>
    </div>
  )
}

const STATUS_VARIANT: Record<SquadsProposalInfo['status'], 'default' | 'destructive' | 'outline' | 'secondary'> = {
  active: 'secondary',
  approved: 'default',
  cancelled: 'outline',
  draft: 'outline',
  executed: 'outline',
  rejected: 'destructive',
}

function ProposalRow({
  account,
  network,
  onDone,
  proposal,
  threshold,
}: {
  account: Account
  network: ReturnType<typeof useNetworkActive>
  onDone: () => void
  proposal: SquadsProposalInfo & { kind: 'config' | 'unknown' | 'vault' }
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
    onError: (error) => toastError(error instanceof Error ? error.message : String(error)),
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

function SpendProposalCard({
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
    onError: (error) => toastError(error instanceof Error ? error.message : String(error)),
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

function SpendingLimitCard({
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
          members: [],
          mint: SOL_MINT,
          multisigPda,
          period,
          spendingLimitCreateKey: createKey,
          transactionIndex: multisigInfo.transactionIndex + 1n,
        }),
      )
    },
    onError: (error) => toastError(error instanceof Error ? error.message : String(error)),
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
              members: [],
              mint: SOL_MINT,
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
