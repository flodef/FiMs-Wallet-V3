import type { Account } from '@workspace/db/account/account'
import { envAdminAddresses } from '@workspace/env/env'
import { useTranslation } from '@workspace/i18n'
import { Badge } from '@workspace/ui/components/badge'
import { Button } from '@workspace/ui/components/button'
import { Input } from '@workspace/ui/components/input'
import { Label } from '@workspace/ui/components/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select'
import { Textarea } from '@workspace/ui/components/textarea'
import { UiCard } from '@workspace/ui/components/ui-card'
import { UiLoader } from '@workspace/ui/components/ui-loader'
import { toastError } from '@workspace/ui/lib/toast-error'
import { toastSuccess } from '@workspace/ui/lib/toast-success'
import { useState } from 'react'
import { useFimsCastBallot, useFimsVoteCreate, useFimsVotes, useFimsVoteUpdate } from './data-access/use-fims.tsx'
import { useFimsCurrency } from './data-access/use-fims-currency.tsx'
import type { FimsVote, FimsVoteKind } from './fims-api.ts'
import { formatDateTime } from './fims-format.ts'

export function FimsFeatureVotes({ account }: { account: Account }) {
  const { t } = useTranslation('fims')
  const votes = useFimsVotes(account)
  const isAdmin = envAdminAddresses().includes(account.publicKey)
  const canSign = account.type !== 'Watched'

  const visible = (votes.data ?? []).filter((vote) => vote.status !== 'draft' || isAdmin)
  const open = visible.filter((vote) => vote.status === 'open')
  const rest = visible.filter((vote) => vote.status !== 'open')

  return (
    <div className="space-y-4">
      {votes.isLoading ? (
        <UiLoader />
      ) : visible.length === 0 ? (
        <UiCard title={t(($) => $.votesTitle)}>
          <p className="text-muted-foreground text-sm">{t(($) => $.votesEmpty)}</p>
        </UiCard>
      ) : (
        [...open, ...rest].map((vote) => (
          <FimsVoteCard account={account} canSign={canSign} isAdmin={isAdmin} key={vote.id} vote={vote} />
        ))
      )}
      {isAdmin ? <FimsVoteCreateCard account={account} /> : null}
    </div>
  )
}

function FimsVoteCard({
  account,
  canSign,
  isAdmin,
  vote,
}: {
  account: Account
  canSign: boolean
  isAdmin: boolean
  vote: FimsVote
}) {
  const { t } = useTranslation('fims')
  const { format } = useFimsCurrency()
  const cast = useFimsCastBallot(account, vote.id)
  const update = useFimsVoteUpdate(account, vote.id)
  const isOpen = vote.status === 'open' && (!vote.closesAt || new Date(vote.closesAt).getTime() > Date.now())

  const handleVote = async (optionId: number) => {
    try {
      await cast.mutateAsync(optionId)
      toastSuccess(t(($) => $.votesCasted))
    } catch (error) {
      toastError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <UiCard
      action={
        <div className="flex items-center gap-2">
          <Badge variant="outline">
            {vote.kind === 'tontine' ? t(($) => $.votesKindTontine) : t(($) => $.votesKindInvestment)}
          </Badge>
          <Badge variant={vote.status === 'open' ? 'default' : 'secondary'}>
            {vote.status === 'open'
              ? t(($) => $.votesStatusOpen)
              : vote.status === 'draft'
                ? t(($) => $.votesStatusDraft)
                : t(($) => $.votesStatusClosed)}
          </Badge>
        </div>
      }
      title={vote.title}
    >
      <div className="space-y-3">
        {vote.description ? <p className="text-muted-foreground text-sm">{vote.description}</p> : null}
        {vote.closesAt ? (
          <p className="text-muted-foreground text-xs">
            {t(($) => $.votesClosesAt)} {formatDateTime(vote.closesAt)}
          </p>
        ) : null}
        <p className="text-muted-foreground text-xs">
          {vote.kind === 'tontine' ? t(($) => $.votesWeightTontine) : t(($) => $.votesWeightInvestment)}
        </p>

        <div className="space-y-2">
          {vote.options.map((option) => {
            const share = vote.totalWeight > 0 ? option.weight / vote.totalWeight : 0
            const mine = vote.myOptionId === option.id
            return (
              <button
                className={`w-full rounded-md border p-3 text-left transition-colors ${
                  mine ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted/50'
                } ${isOpen && canSign ? 'cursor-pointer' : 'cursor-default'}`}
                disabled={!isOpen || !canSign || cast.isPending}
                key={option.id}
                onClick={() => isOpen && canSign && handleVote(option.id)}
                type="button"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-sm">
                    {option.label}
                    {mine ? <span className="ml-2 text-primary text-xs">✓ {t(($) => $.votesYours)}</span> : null}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {option.ballots} {t(($) => $.votesBallots)} · {format(option.weight)} ({(share * 100).toFixed(1)}%)
                  </span>
                </div>
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${share * 100}%` }} />
                </div>
              </button>
            )
          })}
        </div>

        {isAdmin ? (
          <div className="flex justify-end gap-2 pt-1">
            {vote.status !== 'open' ? (
              <Button
                onClick={() => update.mutateAsync({ status: 'open' }).catch(() => {})}
                size="sm"
                variant="outline"
              >
                {t(($) => $.votesOpen)}
              </Button>
            ) : null}
            {vote.status === 'open' ? (
              <Button
                onClick={() => update.mutateAsync({ status: 'closed' }).catch(() => {})}
                size="sm"
                variant="outline"
              >
                {t(($) => $.votesClose)}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </UiCard>
  )
}

function FimsVoteCreateCard({ account }: { account: Account }) {
  const { t } = useTranslation('fims')
  const create = useFimsVoteCreate(account)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [kind, setKind] = useState<FimsVoteKind>('investment')
  const [optionsText, setOptionsText] = useState('')
  const [closesAt, setClosesAt] = useState('')

  const options = optionsText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  const canSubmit = title.trim().length > 0 && options.length >= 2 && !create.isPending

  const handleCreate = async () => {
    try {
      await create.mutateAsync({
        closesAt: closesAt || undefined,
        description: description.trim() || undefined,
        kind,
        options,
        title: title.trim(),
      })
      setTitle('')
      setDescription('')
      setOptionsText('')
      setClosesAt('')
      toastSuccess(t(($) => $.votesCreated))
    } catch (error) {
      toastError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <UiCard title={t(($) => $.votesCreateTitle)}>
      <div className="space-y-4">
        <div className="space-y-2">
          <Label>{t(($) => $.votesFieldTitle)}</Label>
          <Input onChange={(e) => setTitle(e.target.value)} value={title} />
        </div>
        <div className="space-y-2">
          <Label>{t(($) => $.votesFieldDescription)}</Label>
          <Textarea onChange={(e) => setDescription(e.target.value)} value={description} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>{t(($) => $.votesFieldKind)}</Label>
            <Select onValueChange={(v) => setKind(v as FimsVoteKind)} value={kind}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="investment">{t(($) => $.votesKindInvestment)}</SelectItem>
                <SelectItem value="tontine">{t(($) => $.votesKindTontine)}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>{t(($) => $.votesClosesAt)}</Label>
            <Input onChange={(e) => setClosesAt(e.target.value)} type="date" value={closesAt} />
          </div>
        </div>
        <div className="space-y-2">
          <Label>{t(($) => $.votesFieldOptions)}</Label>
          <Textarea
            onChange={(e) => setOptionsText(e.target.value)}
            placeholder={t(($) => $.votesFieldOptionsHint)}
            rows={3}
            value={optionsText}
          />
        </div>
        <div className="flex justify-end">
          <Button disabled={!canSubmit} onClick={handleCreate}>
            {create.isPending ? <UiLoader className="size-4" /> : null}
            {t(($) => $.votesCreate)}
          </Button>
        </div>
      </div>
    </UiCard>
  )
}
