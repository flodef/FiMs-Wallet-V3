import { sendMessage } from './extension.ts'
import { onMessage } from './window.ts'

// The content script is the only component that knows which page is asking:
// it attaches `window.location.origin` to every relayed request, and the
// background service treats that — never anything inside the payload — as
// the dApp's identity.
export function handlers() {
  const origin = window.location.origin
  onMessage('connect', async ({ data }) => await sendMessage('connect', { input: data, origin }))
  onMessage('disconnect', async () => await sendMessage('disconnect', { origin }))
  onMessage(
    'signAndSendTransaction',
    async ({ data }) => await sendMessage('signAndSendTransaction', { inputs: data, origin }),
  )
  onMessage('signIn', async ({ data }) => await sendMessage('signIn', { inputs: data, origin }))
  onMessage('signMessage', async ({ data }) => await sendMessage('signMessage', { inputs: data, origin }))
  onMessage('signTransaction', async ({ data }) => await sendMessage('signTransaction', { inputs: data, origin }))
}
