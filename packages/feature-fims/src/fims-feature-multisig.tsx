import { type Address, address, createNoopSigner, generateKeyPairSigner, isAddress } from '@solana/kit'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Account } from '@workspace/db/account/account'
import { useNetworkActive } from '@workspace/db-react/use-network-active'
import { useTranslation } from '@workspace/i18n'
import type { SolanaClient } from '@workspace/solana-client/solana-client'
import { useSolanaClient } from '@workspace/solana-client-react/use-solana-client'
import { Button } from '@workspace/ui/components/button'
import { Input } from '@workspace/ui/components/input'
import { Label } from '@workspace/ui/components/label'
import { UiCard } from '@workspace/ui/components/ui-card'
import { UiLoader } from '@workspace/ui/components/ui-loader'
import { ellipsify } from '@workspace/ui/lib/ellipsify'
import { toastError } from '@workspace/ui/lib/toast-error'
import { toastSuccess } from '@workspace/ui/lib/toast-success'
import { type SyntheticEvent, useId, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { formatSol, randomAddress } from './fims-multisig-helpers.ts'
import { ProposalRow, SpendingLimitCard, SpendProposalCard, SpendViaLimitCard } from './fims-ui-multisig-proposals.tsx'
import { squadsMultisigPda, squadsVaultPda } from './squads/squads.ts'
import { SquadsCostPreview } from './squads/squads-cost-preview.tsx'
import { buildCreateMultisigInstructions } from './squads/squads-tx.ts'
import { useMultisigRegistry } from './squads/use-multisig-registry.tsx'
import {
  fetchSquadsMultisig,
  fetchSquadsProgramConfig,
  fetchSquadsProposals,
  fetchSquadsSpendingLimits,
  useSquadsSignAndSend,
} from './squads/use-squads.tsx'

// Squads marks SOL spending limits with the default public key, not the WSOL
// mint — spendingLimitUse branches on it to pick the native SOL transfer path.
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
  const previewCreateKey = useMemo(() => createNoopSigner(randomAddress()), [])

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
      const createKey = await generateKeyPairSigner()
      const multisigPda = squadsMultisigPda(createKey.address)
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
    onError: (error) => toastError(error),
    onSuccess: ({ label: createdLabel, multisigPda }) => {
      registry.add({ label: createdLabel, networkId: network.id, pda: multisigPda })
      toastSuccess(t(($) => $.multisigCreated))
      onCreated(multisigPda)
    },
  })

  // Step-by-step creation: intro → members → threshold → review, each step
  // gated on its own validity instead of one dense form.
  const STEPS = 4
  const [step, setStep] = useState(0)
  const stepError = 'error' in parsed ? parsed.error : null
  const canNext =
    step === 0 || (step === 1 && stepError !== 'address') || (step === 2 && parsedValid != null) || step === 3

  const stepTitles = [
    t(($) => $.multisigStepIntroTitle),
    t(($) => $.multisigStepMembersTitle),
    t(($) => $.multisigStepThresholdTitle),
    t(($) => $.multisigStepRecapTitle),
  ]

  return (
    <UiCard title={t(($) => $.multisigCreateTitle)}>
      <form
        className="space-y-4"
        onSubmit={(event: SyntheticEvent) => {
          event.preventDefault()
          // Enter inside a field acts as "next step"; only the recap submits.
          if (step === STEPS - 1) create.mutate()
          else if (canNext) setStep((s) => s + 1)
        }}
      >
        <div className="flex items-center justify-between">
          <p className="font-medium text-sm">{stepTitles[step]}</p>
          <p className="text-muted-foreground text-xs">
            {t(($) => $.multisigStepCount, { current: step + 1, total: STEPS })}
          </p>
        </div>
        <div className="flex gap-1.5">
          {stepTitles.map((title, i) => (
            <span className={`h-1 flex-1 rounded-full ${i <= step ? 'bg-primary' : 'bg-muted'}`} key={title} />
          ))}
        </div>

        {step === 0 ? (
          <div className="space-y-2">
            <p className="text-muted-foreground text-sm">{t(($) => $.multisigStepIntroBody)}</p>
            <p className="text-muted-foreground text-xs">{t(($) => $.multisigSelfIncluded)}</p>
          </div>
        ) : null}

        {step === 1 ? (
          <div className="space-y-3">
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
              {stepError === 'address' ? (
                <p className="text-destructive text-xs">{t(($) => $.multisigInvalidAddress)}</p>
              ) : null}
            </div>
          </div>
        ) : null}

        {step === 2 ? (
          <div className="space-y-3">
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
            <p className={parsedValid ? 'text-muted-foreground text-xs' : 'text-destructive text-xs'}>
              {parsedValid
                ? t(($) => $.multisigStepThresholdHint, {
                    members: parsedValid.members.length,
                    threshold: parsedValid.threshold,
                  })
                : t(($) => $.multisigInvalidThreshold)}
            </p>
          </div>
        ) : null}

        {step === 3 ? (
          <div className="space-y-3">
            <div className="rounded-md border p-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t(($) => $.multisigLabel)}</span>
                <span>{label || '—'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t(($) => $.multisigMembers)}</span>
                <span>{parsedValid?.members.length ?? '—'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t(($) => $.multisigThreshold)}</span>
                <span>
                  {parsedValid
                    ? t(($) => $.multisigStepThresholdHint, {
                        members: parsedValid.members.length,
                        threshold: parsedValid.threshold,
                      })
                    : '—'}
                </span>
              </div>
            </div>
            <SquadsCostPreview
              buildInstructions={() =>
                buildCreateMultisigInstructions({
                  createKey: previewCreateKey,
                  creator: account.publicKey as Address,
                  members: parsedValid?.members ?? [],
                  multisigPda: squadsMultisigPda(previewCreateKey.address),
                  threshold: parsedValid?.threshold ?? 1,
                  treasury: config.data?.treasury ?? account.publicKey,
                })
              }
              client={client}
              inputKey={parsedValid && config.data ? `${parsedValid.threshold}:${parsedValid.members.join(',')}` : ''}
              payer={account.publicKey as Address}
              protocolFee={config.data?.multisigCreationFee}
            />
          </div>
        ) : null}

        <div className="flex justify-between">
          <Button
            disabled={step === 0}
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            type="button"
            variant="ghost"
          >
            {t(($) => $.multisigBack)}
          </Button>
          {step < STEPS - 1 ? (
            <Button disabled={!canNext} onClick={() => setStep((s) => s + 1)} type="button">
              {t(($) => $.multisigNext)}
            </Button>
          ) : (
            <Button disabled={create.isPending || config.isLoading || !parsedValid} type="submit">
              {create.isPending ? <UiLoader /> : t(($) => $.multisigCreateButton)}
            </Button>
          )}
        </div>
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
          <SpendViaLimitCard
            account={account}
            limits={spending.data ?? []}
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
