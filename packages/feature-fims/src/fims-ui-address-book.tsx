import type { Account } from '@workspace/db/account/account'
import { useTranslation } from '@workspace/i18n'
import { Badge } from '@workspace/ui/components/badge'
import { Button } from '@workspace/ui/components/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@workspace/ui/components/dialog'
import { Input } from '@workspace/ui/components/input'
import { Label } from '@workspace/ui/components/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select'
import { Spinner } from '@workspace/ui/components/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@workspace/ui/components/table'
import { UiCard } from '@workspace/ui/components/ui-card'
import { UiConfirm } from '@workspace/ui/components/ui-confirm'
import { UiIcon } from '@workspace/ui/components/ui-icon'
import { UiLoader } from '@workspace/ui/components/ui-loader'
import { type SyntheticEvent, useId, useState } from 'react'
import {
  useFimsAddressBook,
  useFimsAddressBookCreate,
  useFimsAddressBookDelete,
  useFimsAddressBookUpdate,
} from './data-access/use-fims.tsx'
import type { FimsAddressBookEntry, FimsAddressBookType } from './fims-api.ts'
import { FimsUiSnsAddress } from './fims-ui-sns-address.tsx'

const TYPES: FimsAddressBookType[] = ['nexo', 'coinbase', 'binance', 'fimseur', 'other']

function AddressBookTypeLabel({ type }: { type: FimsAddressBookType }) {
  const { t } = useTranslation('fims')
  switch (type) {
    case 'binance':
      return t(($) => $.addressBookTypeBinance)
    case 'coinbase':
      return t(($) => $.addressBookTypeCoinbase)
    case 'fimseur':
      return t(($) => $.addressBookTypeFimseur)
    case 'nexo':
      return t(($) => $.addressBookTypeNexo)
    case 'other':
      return t(($) => $.addressBookTypeOther)
    default:
      return type
  }
}

function AddressBookFormDialog({
  account,
  entry,
  userId,
}: {
  account: Account
  entry?: FimsAddressBookEntry
  userId: number
}) {
  const { t } = useTranslation('fims')
  const [open, setOpen] = useState(false)
  const [label, setLabel] = useState(entry?.label ?? '')
  const [address, setAddress] = useState(entry?.address ?? '')
  const [type, setType] = useState<FimsAddressBookType>(entry?.type ?? 'other')
  const labelId = useId()
  const addressId = useId()
  const create = useFimsAddressBookCreate(account, userId)
  const update = useFimsAddressBookUpdate(account, userId)
  const pending = create.isPending || update.isPending

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault()
    if (entry) {
      await update.mutateAsync({ address, id: entry.id, label, type })
    } else {
      await create.mutateAsync({ address, label, type })
    }
    setOpen(false)
    setLabel('')
    setAddress('')
    setType('other')
  }

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>
        {entry ? (
          <Button size="icon" variant="ghost">
            <UiIcon className="size-4" icon="edit" />
          </Button>
        ) : (
          <Button size="sm" variant="outline">
            <UiIcon className="size-4" icon="add" />
            {t(($) => $.addressBookAdd)}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{entry ? t(($) => $.addressBookEditTitle) : t(($) => $.addressBookAddTitle)}</DialogTitle>
          <DialogDescription>{t(($) => $.addressBookDescription)}</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          <div className="space-y-2">
            <Label htmlFor={labelId}>{t(($) => $.addressBookLabel)}</Label>
            <Input id={labelId} onChange={(e) => setLabel(e.target.value)} required value={label} />
          </div>
          <div className="space-y-2">
            <Label htmlFor={addressId}>{t(($) => $.addressBookAddress)}</Label>
            <Input id={addressId} onChange={(e) => setAddress(e.target.value)} required value={address} />
          </div>
          <div className="space-y-2">
            <Label>{t(($) => $.addressBookType)}</Label>
            <Select onValueChange={(v) => setType(v as FimsAddressBookType)} value={type}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TYPES.map((item) => (
                  <SelectItem key={item} value={item}>
                    {<AddressBookTypeLabel type={item} />}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button disabled={pending || !label || !address} type="submit">
              {pending ? <Spinner /> : t(($) => $.addressBookSave)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function FimsUiAddressBook({ account, userId }: { account: Account; userId: number }) {
  const { t } = useTranslation('fims')
  const entries = useFimsAddressBook(userId, account)
  const remove = useFimsAddressBookDelete(account, userId)
  const canSign = account.type !== 'Watched'

  return (
    <UiCard
      action={canSign ? <AddressBookFormDialog account={account} userId={userId} /> : null}
      title={t(($) => $.addressBookTitle)}
    >
      {entries.isLoading ? (
        <UiLoader />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t(($) => $.addressBookLabel)}</TableHead>
              <TableHead>{t(($) => $.addressBookAddress)}</TableHead>
              <TableHead>{t(($) => $.addressBookType)}</TableHead>
              {canSign ? <TableHead className="w-20 text-right">{t(($) => $.addressBookActions)}</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {(entries.data ?? []).map((entry) => (
              <TableRow key={entry.id}>
                <TableCell className="font-medium">{entry.label}</TableCell>
                <TableCell>
                  <FimsUiSnsAddress address={entry.address} />
                </TableCell>
                <TableCell>
                  <Badge variant="outline">
                    <AddressBookTypeLabel type={entry.type} />
                  </Badge>
                </TableCell>
                {canSign ? (
                  <TableCell className="text-right">
                    <AddressBookFormDialog account={account} entry={entry} userId={userId} />
                    <UiConfirm
                      action={async () => {
                        await remove.mutateAsync(entry.id)
                      }}
                      actionLabel={t(($) => $.addressBookDeleteConfirm)}
                      actionVariant="destructive"
                      description={t(($) => $.addressBookDeleteDescription, { label: entry.label })}
                      title={t(($) => $.addressBookDeleteTitle)}
                      trigger={
                        <Button size="icon" variant="ghost">
                          <UiIcon className="size-4 text-red-500" icon="delete" />
                        </Button>
                      }
                    />
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
            {entries.data?.length === 0 ? (
              <TableRow>
                <TableCell className="text-center text-muted-foreground" colSpan={canSign ? 4 : 3}>
                  {t(($) => $.addressBookEmpty)}
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      )}
    </UiCard>
  )
}
