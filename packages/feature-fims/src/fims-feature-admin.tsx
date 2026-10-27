// cspell:ignore Annuaire

import { useQuery } from '@tanstack/react-query'
import type { Account } from '@workspace/db/account/account'
import type { Network } from '@workspace/db/network/network'
import { useIsAdmin } from '@workspace/db-react/use-is-admin'
import { PortfolioFeatureChainReader } from '@workspace/feature-portfolio/portfolio-feature-chain-reader'
import { useTranslation } from '@workspace/i18n'
import { localizedErrorMessage } from '@workspace/i18n/localized-error'
import { Button } from '@workspace/ui/components/button'
import { Input } from '@workspace/ui/components/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@workspace/ui/components/table'
import { UiCard } from '@workspace/ui/components/ui-card'
import { UiError } from '@workspace/ui/components/ui-error'
import { UiLoader } from '@workspace/ui/components/ui-loader'
import { ellipsify } from '@workspace/ui/lib/ellipsify'
import { useMemo, useState } from 'react'
import {
  useFimsAdminTransactionCreate,
  useFimsAdminTransactionDelete,
  useFimsAdminTransactionUpdate,
  useFimsAdminUserCreate,
  useFimsAdminUserDelete,
  useFimsAdminUserUpdate,
  useFimsSignedGetAll,
  useFimsTokens,
  useFimsTransactions,
} from './data-access/use-fims.tsx'
import type { FimsTransaction, FimsTransactionType, FimsUser } from './fims-api.ts'

const TX_TYPES: FimsTransactionType[] = [
  'deposit',
  'withdrawal',
  'conversion',
  'payment',
  'donation',
  'cex_in',
  'cex_out',
  'tontine',
]

// Admin ledger console (v1 /admin): member CRUD, transaction CRUD and the
// on-chain viewer — all behind the API's admin allowlist anyway; the client
// gate only hides the page from members.
export function FimsFeatureAdmin({ account, network }: { account: Account; network: Network }) {
  const { t } = useTranslation('fims')
  const isAdmin = useIsAdmin()
  const signedGetAll = useFimsSignedGetAll(account)
  const users = useQuery({
    enabled: isAdmin,
    queryFn: () => signedGetAll<FimsUser>('/users'),
    queryKey: ['fims', 'users', 'admin', account.publicKey],
  })

  if (!isAdmin) {
    return <UiError message={new Error(t(($) => $.adminNotAllowed))} title={t(($) => $.adminTitle)} />
  }
  return (
    <div className="space-y-4">
      <AdminUsersCard account={account} isLoading={users.isLoading} users={users.data ?? []} />
      <AdminTransactionsCard account={account} users={users.data ?? []} />
      <UiCard title={t(($) => $.adminChainTitle)}>
        <PortfolioFeatureChainReader account={account} network={network} />
      </UiCard>
    </div>
  )
}

// ── Members CRUD ──────────────────────────────────────────────────────────

interface UserDraft {
  address: string
  id: null | number
  isPro: boolean
  isPublic: boolean
  name: string
}

const emptyUserDraft: UserDraft = { address: '', id: null, isPro: false, isPublic: false, name: '' }

function AdminUsersCard({ account, isLoading, users }: { account: Account; isLoading: boolean; users: FimsUser[] }) {
  const { t } = useTranslation('fims')
  const [draft, setDraft] = useState<UserDraft>(emptyUserDraft)
  const create = useFimsAdminUserCreate(account)
  const update = useFimsAdminUserUpdate(account)
  const del = useFimsAdminUserDelete(account)
  const busy = create.isPending || update.isPending || del.isPending
  const error = create.error ?? update.error ?? del.error

  const submit = () => {
    if (draft.id === null) {
      create.mutate(
        { address: draft.address.trim(), isPublic: draft.isPublic, name: draft.name.trim() },
        { onSuccess: () => setDraft(emptyUserDraft) },
      )
    } else {
      update.mutate(
        {
          address: draft.address.trim(),
          id: draft.id,
          isPro: draft.isPro,
          isPublic: draft.isPublic,
          name: draft.name.trim(),
        },
        { onSuccess: () => setDraft(emptyUserDraft) },
      )
    }
  }

  return (
    <UiCard title={t(($) => $.adminUsersTitle)}>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <Input
          className="w-40"
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          placeholder={t(($) => $.adminFieldName)}
          value={draft.name}
        />
        <Input
          className="min-w-0 flex-1 font-mono text-xs"
          onChange={(e) => setDraft({ ...draft, address: e.target.value })}
          placeholder={t(($) => $.adminFieldAddress)}
          value={draft.address}
        />
        <label className="flex items-center gap-1 text-sm">
          <input
            checked={draft.isPublic}
            onChange={(e) => setDraft({ ...draft, isPublic: e.target.checked })}
            type="checkbox"
          />
          {t(($) => $.adminFieldPublic)}
        </label>
        {draft.id !== null ? (
          <label className="flex items-center gap-1 text-sm">
            <input
              checked={draft.isPro}
              onChange={(e) => setDraft({ ...draft, isPro: e.target.checked })}
              type="checkbox"
            />
            {t(($) => $.adminFieldPro)}
          </label>
        ) : null}
        <Button disabled={busy || !draft.name.trim() || !draft.address.trim()} onClick={submit} size="sm">
          {draft.id === null ? t(($) => $.adminCreate) : t(($) => $.adminUpdate)}
        </Button>
        {draft.id !== null ? (
          <Button onClick={() => setDraft(emptyUserDraft)} size="sm" variant="ghost">
            {t(($) => $.adminCancel)}
          </Button>
        ) : null}
      </div>
      {error ? (
        <pre className="alert alert-error mb-2 whitespace-pre-wrap text-xs">{localizedErrorMessage(error)}</pre>
      ) : null}
      {isLoading ? (
        <UiLoader />
      ) : (
        <div className="max-h-80 overflow-y-auto">
          <Table>
            <TableHeader className="sticky top-0 bg-background">
              <TableRow>
                <TableHead>{t(($) => $.columnName)}</TableHead>
                <TableHead>{t(($) => $.columnAddress)}</TableHead>
                <TableHead>{t(($) => $.adminFieldFlags)}</TableHead>
                <TableHead className="text-right">{t(($) => $.adminFieldActions)}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((user) => (
                <TableRow key={user.id}>
                  <TableCell className="font-medium">{user.name}</TableCell>
                  <TableCell className="font-mono text-xs">{ellipsify(user.address)}</TableCell>
                  <TableCell className="text-xs">
                    {user.isPublic ? t(($) => $.badgePublic) : t(($) => $.badgePrivate)}
                    {user.isPro ? ` · ${t(($) => $.badgePro)}` : ''}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="inline-flex gap-1">
                      <Button
                        onClick={() =>
                          setDraft({
                            address: user.address,
                            id: user.id,
                            isPro: user.isPro,
                            isPublic: user.isPublic,
                            name: user.name,
                          })
                        }
                        size="sm"
                        variant="outline"
                      >
                        {t(($) => $.adminEdit)}
                      </Button>
                      <Button
                        disabled={busy}
                        onClick={() => {
                          if (window.confirm(t(($) => $.adminDeleteConfirm, { name: user.name }))) del.mutate(user.id)
                        }}
                        size="sm"
                        variant="destructive"
                      >
                        {t(($) => $.adminDelete)}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </UiCard>
  )
}

// ── Transactions CRUD ─────────────────────────────────────────────────────

interface TxDraft {
  amount: string
  cost: string
  date: string
  donationAmount: string
  donationTarget: string
  id: null | number
  movement: string
  token: string
  type: FimsTransactionType
  userId: number
}

function draftFromTx(tx: FimsTransaction): TxDraft {
  return {
    amount: tx.amount ?? '',
    cost: String(tx.cost),
    date: tx.date.slice(0, 10),
    donationAmount: tx.donationAmount ?? '',
    donationTarget: tx.donationTarget ?? '',
    id: tx.id,
    movement: String(tx.movement),
    token: tx.token ?? '',
    type: tx.type ?? 'deposit',
    userId: tx.userId ?? 0,
  }
}

function AdminTransactionsCard({ account, users }: { account: Account; users: FimsUser[] }) {
  const { t } = useTranslation('fims')
  const tokens = useFimsTokens()
  const [userId, setUserId] = useState<number>(0)
  const txs = useFimsTransactions(userId ? { userId } : undefined, account, userId > 0)
  const create = useFimsAdminTransactionCreate(account)
  const update = useFimsAdminTransactionUpdate(account)
  const del = useFimsAdminTransactionDelete(account)
  const busy = create.isPending || update.isPending || del.isPending
  const error = create.error ?? update.error ?? del.error

  const tokenOptions = useMemo(() => (tokens.data ?? []).map((token) => token.symbol), [tokens.data])
  const [draft, setDraft] = useState<TxDraft | null>(null)

  const startCreate = (target: number) =>
    setDraft({
      amount: '',
      cost: '0',
      date: new Date().toISOString().slice(0, 10),
      donationAmount: '',
      donationTarget: '',
      id: null,
      movement: '',
      token: tokenOptions[0] ?? 'FiMs',
      type: 'deposit',
      userId: target,
    })

  const submit = () => {
    if (!draft) return
    const base = {
      amount: draft.amount || undefined,
      cost: Number(draft.cost) || 0,
      date: new Date(draft.date).toISOString(),
      donationAmount: draft.donationAmount || undefined,
      donationTarget: draft.donationTarget || undefined,
      movement: Number(draft.movement),
      token: draft.token || undefined,
      type: draft.type,
    }
    if (draft.id === null) {
      create.mutate({ ...base, userId: draft.userId }, { onSuccess: () => setDraft(null) })
    } else {
      update.mutate({ ...base, id: draft.id }, { onSuccess: () => setDraft(null) })
    }
  }

  const rows = useMemo(() => (txs.data ?? []).slice(0, 100), [txs.data])

  return (
    <UiCard title={t(($) => $.adminTxTitle)}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select onValueChange={(value) => setUserId(Number(value))} value={userId ? String(userId) : ''}>
          <SelectTrigger className="w-56">
            <SelectValue placeholder={t(($) => $.adminSelectMember)} />
          </SelectTrigger>
          <SelectContent>
            {users.map((user) => (
              <SelectItem key={user.id} value={String(user.id)}>
                {user.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {userId > 0 ? (
          <Button onClick={() => startCreate(userId)} size="sm">
            {t(($) => $.adminNewTx)}
          </Button>
        ) : null}
      </div>

      {draft ? (
        <div className="mb-4 flex flex-wrap items-end gap-2 rounded-md border p-3">
          <div className="flex flex-col gap-1 text-xs">
            <span>{t(($) => $.adminFieldDate)}</span>
            <Input onChange={(e) => setDraft({ ...draft, date: e.target.value })} type="date" value={draft.date} />
          </div>
          <div className="flex flex-col gap-1 text-xs">
            <span>{t(($) => $.adminFieldType)}</span>
            <Select onValueChange={(v) => setDraft({ ...draft, type: v as FimsTransactionType })} value={draft.type}>
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TX_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {type}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1 text-xs">
            <span>{t(($) => $.adminFieldToken)}</span>
            <Select onValueChange={(v) => setDraft({ ...draft, token: v })} value={draft.token}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {tokenOptions.map((symbol) => (
                  <SelectItem key={symbol} value={symbol}>
                    {symbol}
                  </SelectItem>
                ))}
                <SelectItem value="EUR">EUR</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1 text-xs">
            <span>{t(($) => $.adminFieldUnits)}</span>
            <Input
              className="w-28"
              inputMode="decimal"
              onChange={(e) => setDraft({ ...draft, amount: e.target.value })}
              value={draft.amount}
            />
          </div>
          <div className="flex flex-col gap-1 text-xs">
            <span>{t(($) => $.adminFieldMovement)}</span>
            <Input
              className="w-28"
              inputMode="decimal"
              onChange={(e) => setDraft({ ...draft, movement: e.target.value })}
              value={draft.movement}
            />
          </div>
          <div className="flex flex-col gap-1 text-xs">
            <span>{t(($) => $.adminFieldCost)}</span>
            <Input
              className="w-24"
              inputMode="decimal"
              onChange={(e) => setDraft({ ...draft, cost: e.target.value })}
              value={draft.cost}
            />
          </div>
          <div className="flex flex-col gap-1 text-xs">
            <span>{t(($) => $.adminFieldDonation)}</span>
            <Input
              className="w-24"
              inputMode="decimal"
              onChange={(e) => setDraft({ ...draft, donationAmount: e.target.value })}
              value={draft.donationAmount}
            />
          </div>
          <div className="flex flex-col gap-1 text-xs">
            <span>{t(($) => $.adminFieldDonationTarget)}</span>
            <Input
              className="w-28"
              onChange={(e) => setDraft({ ...draft, donationTarget: e.target.value })}
              value={draft.donationTarget}
            />
          </div>
          <div className="flex gap-1">
            <Button disabled={busy || !draft.movement} onClick={submit} size="sm">
              {draft.id === null ? t(($) => $.adminCreate) : t(($) => $.adminUpdate)}
            </Button>
            <Button onClick={() => setDraft(null)} size="sm" variant="ghost">
              {t(($) => $.adminCancel)}
            </Button>
          </div>
        </div>
      ) : null}

      {error ? (
        <pre className="alert alert-error mb-2 whitespace-pre-wrap text-xs">{localizedErrorMessage(error)}</pre>
      ) : null}
      {userId > 0 ? (
        txs.isLoading ? (
          <UiLoader />
        ) : (
          <div className="max-h-96 overflow-y-auto">
            <Table>
              <TableHeader className="sticky top-0 bg-background">
                <TableRow>
                  <TableHead>{t(($) => $.adminFieldDate)}</TableHead>
                  <TableHead>{t(($) => $.adminFieldType)}</TableHead>
                  <TableHead>{t(($) => $.adminFieldToken)}</TableHead>
                  <TableHead className="text-right">{t(($) => $.adminFieldUnits)}</TableHead>
                  <TableHead className="text-right">{t(($) => $.adminFieldMovement)}</TableHead>
                  <TableHead className="text-right">{t(($) => $.adminFieldCost)}</TableHead>
                  <TableHead className="text-right">{t(($) => $.adminFieldActions)}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((tx) => (
                  <TableRow key={tx.id}>
                    <TableCell className="text-xs">{tx.date.slice(0, 10)}</TableCell>
                    <TableCell className="text-xs">{tx.type ?? '—'}</TableCell>
                    <TableCell className="text-xs">{tx.token ?? '—'}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{tx.amount ?? '—'}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{tx.movement}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{tx.cost}</TableCell>
                    <TableCell className="text-right">
                      <div className="inline-flex gap-1">
                        <Button onClick={() => setDraft(draftFromTx(tx))} size="sm" variant="outline">
                          {t(($) => $.adminEdit)}
                        </Button>
                        <Button
                          disabled={busy}
                          onClick={() => {
                            if (window.confirm(t(($) => $.adminDeleteTxConfirm))) del.mutate(tx.id)
                          }}
                          size="sm"
                          variant="destructive"
                        >
                          {t(($) => $.adminDelete)}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )
      ) : (
        <p className="text-muted-foreground text-sm">{t(($) => $.adminSelectMemberHint)}</p>
      )}
    </UiCard>
  )
}
