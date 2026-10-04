import type { Account } from '@workspace/db/account/account'
import { useAccountsLive } from '@workspace/db-react/use-accounts-live'
import { useTranslation } from '@workspace/i18n'
import { Button } from '@workspace/ui/components/button'
import { Input } from '@workspace/ui/components/input'
import { Label } from '@workspace/ui/components/label'
import { Spinner } from '@workspace/ui/components/spinner'
import { UiCard } from '@workspace/ui/components/ui-card'
import { toastError } from '@workspace/ui/lib/toast-error'
import { toastSuccess } from '@workspace/ui/lib/toast-success'
import { type SyntheticEvent, useId, useState } from 'react'
import { Link } from 'react-router'
import { useFimsUserClaim } from './data-access/use-fims.tsx'
import { FimsApiError } from './fims-api.ts'

// The wallet address is unknown to the API: ask for a member name once.
// - name free            → self-register (the wallet becomes the member)
// - name already ours    → link this wallet to that member (no duplicate)
// - name taken by others → rejected server-side (display names are unique)
export function FimsUiMemberClaim({ account }: { account: Account }) {
  const { t } = useTranslation('fims')
  const accounts = useAccountsLive()
  const claim = useFimsUserClaim(account, accounts)
  const [name, setName] = useState('')
  const nameId = useId()
  const canSign = account.type !== 'Watched'

  const submit = (e: SyntheticEvent) => {
    e.preventDefault()
    claim.mutate(name.trim(), {
      onError: (error) => {
        // 403 = the name exists but no local account is linked to it — either
        // someone else's, or ours on a wallet not imported in this app.
        toastError(
          error instanceof FimsApiError && error.status === 403
            ? t(($) => $.memberClaimNameTaken)
            : error instanceof Error
              ? error.message
              : String(error),
        )
      },
      onSuccess: (result) => {
        toastSuccess(result.action === 'linked' ? t(($) => $.memberClaimLinked) : t(($) => $.memberClaimRegistered))
      },
    })
  }

  return (
    <UiCard title={t(($) => $.memberNotFoundTitle)}>
      <p className="text-muted-foreground text-sm">
        {t(($) => $.memberNotFoundDescription)}
        <br />
        <Link className="text-primary underline" to="/fims/community">
          {t(($) => $.memberNotFoundCommunityLink)}
        </Link>
      </p>
      {canSign ? (
        <form className="space-y-3 pt-4" onSubmit={submit}>
          <div className="space-y-2">
            <Label htmlFor={nameId}>{t(($) => $.memberClaimName)}</Label>
            <Input
              id={nameId}
              maxLength={50}
              onChange={(e) => setName(e.target.value)}
              placeholder={t(($) => $.memberClaimNamePlaceholder)}
              required
              value={name}
            />
            <p className="text-muted-foreground text-xs">{t(($) => $.memberClaimNameHint)}</p>
          </div>
          <Button className="cursor-pointer" disabled={claim.isPending || !name.trim()} type="submit">
            {claim.isPending ? <Spinner /> : t(($) => $.memberClaimSubmit)}
          </Button>
        </form>
      ) : null}
    </UiCard>
  )
}
