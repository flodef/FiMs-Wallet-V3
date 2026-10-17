import { onMessage } from '@workspace/background/extension'
import type { Request } from '@workspace/background/services/request'
import { useEffect, useState } from 'react'
import { RequestUiConnect } from './ui/request-ui-connect.tsx'
import { RequestUiSignAndSendTransaction } from './ui/request-ui-sign-and-send-transaction.tsx'
import { RequestUiSignIn } from './ui/request-ui-sign-in.tsx'
import { RequestUiSignMessage } from './ui/request-ui-sign-message.tsx'
import { RequestUiSignTransaction } from './ui/request-ui-sign-transaction.tsx'

export function RequestFeatureDialog() {
  const [request, setRequest] = useState<Request | null>(null)

  useEffect(() => {
    const createUnsubscribe = onMessage('onRequestCreate', (request) => {
      setRequest(request.data)
    })

    const resetUnsubscribe = onMessage('onRequestReset', () => {
      setRequest(null)
    })

    return () => {
      createUnsubscribe()
      resetUnsubscribe()
    }
  }, [])

  if (!request) {
    return null
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        aria-label="Wallet request"
        aria-modal="true"
        // Partial a11y: role/aria-modal are set, but focus trapping and Escape
        // handling are still missing — a full dialog primitive is a follow-up.
        className="mx-4 w-full max-w-md rounded-lg bg-gray-900 p-6"
        role="dialog"
      >
        {(() => {
          switch (request.type) {
            case 'connect':
              return <RequestUiConnect origin={request.origin} />

            case 'signAndSendTransaction':
              return <RequestUiSignAndSendTransaction data={request.data} origin={request.origin} />

            case 'signIn':
              return <RequestUiSignIn data={request.data} origin={request.origin} />

            case 'signMessage':
              return <RequestUiSignMessage data={request.data} origin={request.origin} />

            case 'signTransaction':
              return <RequestUiSignTransaction data={request.data} origin={request.origin} />

            default:
              throw new Error('Unknown request type')
          }
        })()}
      </div>
    </div>
  )
}
