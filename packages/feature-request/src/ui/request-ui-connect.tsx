import { getDbService } from '@workspace/background/services/db'
import { getRequestService } from '@workspace/background/services/request'
import { useTranslation } from '@workspace/i18n'
import { Button } from '@workspace/ui/components/button'
import { RequestUiOrigin } from './request-ui-origin.tsx'

export interface RequestUiConnectProps {
  origin: string
}

export function RequestUiConnect({ origin }: RequestUiConnectProps) {
  const { t } = useTranslation('request')

  return (
    <div className="flex flex-col gap-4 p-4">
      <h1 className="text-center font-bold text-2xl">{t(($) => $.connectTitle)}</h1>
      <RequestUiOrigin origin={origin} />
      <p className="text-center text-muted-foreground text-sm">{t(($) => $.connectDescription)}</p>
      <div className="flex flex-col gap-2">
        <Button
          onClick={async () => await getRequestService().resolve(await getDbService().account.walletAccounts())}
          variant="destructive"
        >
          {t(($) => $.approve)}
        </Button>
        <Button onClick={async () => await getRequestService().reject()}>{t(($) => $.reject)}</Button>
      </div>
    </div>
  )
}
