// cspell:ignore Annuaire Mseurs
import { useTranslation } from '@workspace/i18n'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@workspace/ui/components/table'
import { UiCard } from '@workspace/ui/components/ui-card'
import { UiLoader } from '@workspace/ui/components/ui-loader'
import { UiTextCopyIcon } from '@workspace/ui/components/ui-text-copy-icon'
import { ellipsify } from '@workspace/ui/lib/ellipsify'
import { useMemo } from 'react'
import { useFimsUsers } from './data-access/use-fims.tsx'
import type { FimsUser } from './fims-api.ts'

// Member directory (v1 "Annuaire des FiMseurs"): only members who chose a
// public profile are listed — and the list itself is gated behind the
// reciprocity rule: keep your own profile private and you see the hint
// instead of the other members.
export function FimsUiMemberDirectory({ member }: { member: FimsUser }) {
  const { t } = useTranslation('fims')
  const users = useFimsUsers()

  const entries = useMemo(() => {
    const rows = (users.data ?? []).filter((user) => user.isPublic)
    return rows.sort((a, b) => (a.id === member.id ? -1 : b.id === member.id ? 1 : a.name.localeCompare(b.name)))
  }, [users.data, member.id])

  return (
    <UiCard title={t(($) => $.directoryTitle)}>
      {users.isLoading ? (
        <UiLoader />
      ) : member.isPublic ? (
        entries.length ? (
          <div className="max-h-80 overflow-y-auto">
            <Table>
              <TableHeader className="sticky top-0 bg-background">
                <TableRow>
                  <TableHead>{t(($) => $.columnName)}</TableHead>
                  <TableHead className="text-right">{t(($) => $.columnAddress)}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell className="font-medium">
                      {user.name}
                      {user.id === member.id ? (
                        <span className="text-muted-foreground text-xs"> ({t(($) => $.directoryYou)})</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      <span className="inline-flex items-center gap-1">
                        {ellipsify(user.address)}
                        <UiTextCopyIcon text={user.address} toast={t(($) => $.profileAddressCopied)} />
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">{t(($) => $.directoryEmpty)}</p>
        )
      ) : (
        <p className="text-muted-foreground text-sm">{t(($) => $.directoryBecomePublic)}</p>
      )}
    </UiCard>
  )
}
