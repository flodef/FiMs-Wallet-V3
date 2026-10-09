import type { SolanaSignMessageInput } from '@solana/wallet-standard-features'

import { getRequestService } from '@workspace/background/services/request'
import { getSignService } from '@workspace/background/services/sign'
import { decodeTransportBytes } from '@workspace/background/transport-bytes'
import { useTranslation } from '@workspace/i18n'
import { Button } from '@workspace/ui/components/button'
import { UiPre } from '@workspace/ui/components/ui-pre'
import { UiWarning } from '@workspace/ui/components/ui-warning'
import { ellipsify } from '@workspace/ui/lib/ellipsify'
import { useRequestSignApproval } from '../data-access/use-request-sign-approval.tsx'
import { RequestUiOrigin } from './request-ui-origin.tsx'
import { RequestUiUnlockDialog } from './request-ui-unlock-dialog.tsx'

export interface RequestUiSignMessageProps {
  data: SolanaSignMessageInput[]
  origin: string
}

// Printable UTF-8 → shown as text. Anything else → hex + a warning: binary
// payloads are exactly how blind-signing attacks hide.
function describeMessage(bytes: Uint8Array): { hex: string; text: string | null } {
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ')
  let text: string | null = null
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    // Reject if it is mostly control characters — printable text only.
    const controls = [...decoded].filter((c) => {
      const code = c.codePointAt(0) ?? 0
      return code < 0x20 && c !== '\n' && c !== '\r' && c !== '\t'
    }).length
    if (controls === 0) {
      text = decoded
    }
  } catch {
    // not valid UTF-8 → hex only
  }
  return { hex, text }
}

export function RequestUiSignMessage({ data, origin }: RequestUiSignMessageProps) {
  const approval = useRequestSignApproval()
  const { t } = useTranslation('request')

  return (
    <div className="flex flex-col gap-4 p-4">
      <h1 className="text-center font-bold text-2xl">{t(($) => $.signMessageTitle)}</h1>
      <RequestUiOrigin origin={origin} />
      {data.map((input, index) => {
        const message = describeMessage(decodeTransportBytes(input.message))
        return (
          <div className="flex flex-col gap-2" key={index}>
            <div className="flex items-center justify-between rounded-md border p-3 text-sm">
              <span className="text-muted-foreground">{t(($) => $.signMessageAccount)}</span>
              <span className="font-mono" title={input.account.address}>
                {ellipsify(input.account.address)}
              </span>
            </div>
            {message.text === null ? <UiWarning>{t(($) => $.signMessageBinary)}</UiWarning> : null}
            <UiPre className="max-h-40 overflow-auto whitespace-pre-wrap break-all">
              {message.text ?? message.hex}
            </UiPre>
          </div>
        )
      })}
      <div className="flex flex-col gap-2">
        <Button
          disabled={approval.state.isBusy}
          onClick={() =>
            approval.approve(
              async () => await getRequestService().resolve(await getSignService().signMessage(data, origin)),
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
