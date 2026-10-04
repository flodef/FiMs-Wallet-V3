import type { Address } from '@solana/kit'
import { useTranslation } from '@workspace/i18n'
import { NATIVE_MINT } from '@workspace/solana-client/constants'
import { parseSolanaPayUrl } from '@workspace/solana-client/solana-pay-url'
import { toastError } from '@workspace/ui/lib/toast-error'
import { useLocation, useNavigate } from 'react-router'

// The request fields the send flow cannot carry in route params — passed
// through location state to the confirm screen (memo + references go into a
// Memo instruction, label/message are shown to the payer).
export interface SolanaPayRequestState {
  payRequest?: {
    label?: string
    memo?: string
    message?: string
    references?: Address[]
  }
}

// Turns raw text (QR payload, pasted solana: link, deep-link param) into a
// send navigation: jumps as deep into the send flow as the request allows —
// an amount goes straight to confirmation, a bare recipient stops at amount
// entry. Transaction-request links need a server fetch and are not supported.
export function useSolanaPayRequest() {
  const { t } = useTranslation('portfolio')
  const location = useLocation()
  const navigate = useNavigate()

  return async (raw: string, options?: { from?: string }) => {
    try {
      const request = parseSolanaPayUrl(raw)
      if (request.kind === 'link') {
        toastError(t(($) => $.payLinkUnsupported))
        return
      }
      const state: SolanaPayRequestState & { from: string } = {
        from: options?.from ?? location.pathname,
        payRequest: {
          ...(request.label ? { label: request.label } : {}),
          ...(request.memo ? { memo: request.memo } : {}),
          ...(request.message ? { message: request.message } : {}),
          ...(request.references.length ? { references: request.references } : {}),
        },
      }
      const token = request.splToken ?? NATIVE_MINT
      if (request.amount) {
        await navigate(`/modals/confirm/${token}/${request.recipient}/${request.amount}`, { state })
      } else {
        await navigate(`/modals/send/${token}/${request.recipient}`, { state })
      }
    } catch (error) {
      toastError(error instanceof Error ? error.message : `${error}`)
    }
  }
}
