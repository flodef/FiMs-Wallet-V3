import { connect } from './actions/connect.ts'
import { disconnect } from './actions/disconnect.ts'
import { signAndSendTransaction } from './actions/sign-and-send-transaction.ts'
import { signIn } from './actions/sign-in.ts'
import { signMessage } from './actions/sign-message.ts'
import { signTransaction } from './actions/sign-transaction.ts'
import { onMessage } from './extension.ts'

export function handlers() {
  onMessage('connect', async ({ data }) => await connect(data.input, data.origin))
  onMessage('disconnect', async ({ data }) => await disconnect(data.origin))
  onMessage('signAndSendTransaction', async ({ data }) => await signAndSendTransaction(data.inputs, data.origin))
  onMessage('signIn', async ({ data }) => await signIn(data.inputs, data.origin))
  onMessage('signMessage', async ({ data }) => await signMessage(data.inputs, data.origin))
  onMessage('signTransaction', async ({ data }) => await signTransaction(data.inputs, data.origin))
}
