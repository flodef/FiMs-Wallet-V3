import type { SolanaSignTransactionInput } from '@solana/wallet-standard-features'

import { getRequestService } from '@workspace/background/services/request'
import { getSignService } from '@workspace/background/services/sign'
import { useTranslation } from '@workspace/i18n'
import { Button } from '@workspace/ui/components/button'
import { useState } from 'react'
import { useRequestSignApproval } from '../data-access/use-request-sign-approval.tsx'
import { RequestUiOrigin } from './request-ui-origin.tsx'
import { RequestUiTransactionReview } from './request-ui-transaction-review.tsx'
import { RequestUiUnlockDialog } from './request-ui-unlock-dialog.tsx'

export interface RequestUiSignTransactionProps {
  data: SolanaSignTransactionInput[]
  origin: string
}

export function RequestUiSignTransaction({ data, origin }: RequestUiSignTransactionProps) {
  const approval = useRequestSignApproval()
  const { t } = useTranslation('request')
  const [blockedMap, setBlockedMap] = useState<Record<number, boolean>>({})
  const blocked = Object.values(blockedMap).some(Boolean)

  return (
    <div className="flex flex-col gap-4 p-4">
      <h1 className="text-center font-bold text-2xl">{t(($) => $.signTransactionTitle)}</h1>
      <RequestUiOrigin origin={origin} />
      {data.map((input, index) => (
        <RequestUiTransactionReview
          input={input}
          key={index}
          onBlockedChange={(value) => setBlockedMap((prev) => ({ ...prev, [index]: value }))}
        />
      ))}
      <div className="flex flex-col gap-2">
        <Button
          disabled={approval.state.isBusy || blocked}
          onClick={() =>
            approval.approve(
              async () => await getRequestService().resolve(await getSignService().signTransaction(data, origin)),
            )
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
