import type { SolanaSignInInput } from '@solana/wallet-standard-features'

import { getRequestService } from '@workspace/background/services/request'
import { getSignService } from '@workspace/background/services/sign'
import { useTranslation } from '@workspace/i18n'
import { Button } from '@workspace/ui/components/button'
import { UiWarning } from '@workspace/ui/components/ui-warning'
import { ellipsify } from '@workspace/ui/lib/ellipsify'
import { useRequestSignApproval } from '../data-access/use-request-sign-approval.tsx'
import { RequestUiOrigin } from './request-ui-origin.tsx'
import { RequestUiUnlockDialog } from './request-ui-unlock-dialog.tsx'

export interface RequestSignInProps {
  data: SolanaSignInInput[]
  origin: string
}

export function RequestUiSignIn({ data, origin }: RequestSignInProps) {
  const approval = useRequestSignApproval()
  const { t } = useTranslation('request')
  const host = (() => {
    try {
      return new URL(origin).host
    } catch {
      return origin
    }
  })()

  return (
    <div className="flex flex-col gap-4 p-4">
      <h1 className="text-center font-bold text-2xl">{t(($) => $.signInTitle)}</h1>
      <RequestUiOrigin origin={origin} />
      {data.map((input, index) => (
        <div className="flex flex-col gap-2" key={index}>
          {input.domain && input.domain !== host ? (
            <UiWarning>{t(($) => $.signInDomainMismatch, { domain: input.domain })}</UiWarning>
          ) : null}
          {input.address ? (
            <div className="flex items-center justify-between rounded-md border p-3 text-sm">
              <span className="text-muted-foreground">{t(($) => $.signMessageAccount)}</span>
              <span className="font-mono" title={input.address}>
                {ellipsify(input.address)}
              </span>
            </div>
          ) : null}
        </div>
      ))}
      <div className="flex flex-col gap-2">
        <Button
          disabled={approval.state.isBusy}
          onClick={() =>
            approval.approve(async () => await getRequestService().resolve(await getSignService().signIn(data, origin)))
          }
          variant="destructive"
        >
          {approval.state.isChecking
            ? t(($) => $.checking)
            : approval.state.isApproving
              ? t(($) => $.approving)
              : t(($) => $.approve)}
        </Button>
        <Button onClick={async () => await getRequestService().reject()}>{t(($) => $.reject)}</Button>
      </div>
      <RequestUiUnlockDialog approval={approval} />
    </div>
  )
}
