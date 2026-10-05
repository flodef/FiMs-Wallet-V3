import type { Address } from '@solana/kit'
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
// entry. Transaction-request links route to the pay-request modal, which
// resolves the merchant transaction, reviews it, then signs and sends it.
export function useSolanaPayRequest() {
  const location = useLocation()
  const navigate = useNavigate()

  return async (raw: string, options?: { from?: string }) => {
    try {
      const request = parseSolanaPayUrl(raw)
      const from = options?.from ?? location.pathname
      if (request.kind === 'link') {
        await navigate('/modals/pay-request', { state: { from, link: request.url } })
        return
      }
      const state: SolanaPayRequestState & { from: string } = {
        from,
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
