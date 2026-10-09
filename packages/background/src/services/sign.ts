import {
  address,
  assertIsSendableTransaction,
  type ClusterUrl,
  createSolanaRpc,
  getAddressEncoder,
  getBase58Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  sendTransactionWithoutConfirmingFactory,
  signBytes,
  signTransaction,
} from '@solana/kit'
import { SOLANA_CHAINS } from '@solana/wallet-standard-chains'
import type {
  SolanaSignAndSendTransactionInput,
  SolanaSignAndSendTransactionOutput,
  SolanaSignInInput,
  SolanaSignInOutput,
  SolanaSignMessageInput,
  SolanaSignMessageOutput,
  SolanaSignTransactionInput,
  SolanaSignTransactionOutput,
} from '@solana/wallet-standard-features'
import {
  SolanaSignAndSendTransaction,
  SolanaSignIn,
  SolanaSignMessage,
  SolanaSignTransaction,
} from '@solana/wallet-standard-features'
import { createSignInMessage } from '@solana/wallet-standard-util'
import type { ProxyService, ProxyServiceKey } from '@webext-core/proxy-service'
import { createProxyService, registerService } from '@webext-core/proxy-service'
import type { AppContext } from '@workspace/context/app-context'
import type { Account } from '@workspace/db/account/account'

import { decodeTransportBytes } from '../transport-bytes.ts'
import { getDbService } from './db.ts'
import { grantedAddress, requireGranted } from './permissions.ts'
import { assertMessageSignable } from './sign-guards.ts'

// Signing hardening (was: an explicit "not safe for production" POC):
//   - every call re-verifies the origin grant — the request popup is UX, the
//     enforcement lives here;
//   - the dApp's requested account must be exactly the granted one AND belong
//     to this wallet; signing picks that account's own key, not whatever the
//     active account happens to be;
//   - signMessage refuses anything that decodes as a transaction or carries
//     the API-auth prefix (blind-signing drain / cross-protocol phishing);
//   - signAndSendTransaction goes to the user's ACTIVE network, never the
//     hardcoded devnet.
async function withSigningAccounts<T>(
  ctx: AppContext,
  origin: string,
  addresses: string[],
  operation: (signers: Map<string, { account: Account; keyPair: CryptoKeyPair }>) => Promise<T>,
): Promise<T> {
  const signers = new Map<string, { account: Account; keyPair: CryptoKeyPair }>()
  try {
    for (const addr of new Set(addresses)) {
      await requireGranted(origin, addr)
      const account = await getDbService().account.byPublicKey(addr)
      if (!account) {
        throw new Error(`account ${addr} does not belong to this wallet`)
      }
      signers.set(addr, { account, keyPair: await getDbService().account.keyPairForAccount(account.id) })
    }
    return await operation(signers)
  } finally {
    ctx.vault.lock()
  }
}

function requireSigner(
  signers: Map<string, { account: Account; keyPair: CryptoKeyPair }>,
  addr: string,
): { account: Account; keyPair: CryptoKeyPair } {
  const signer = signers.get(addr)
  if (!signer) {
    throw new Error(`no signer resolved for account ${addr}`)
  }
  return signer
}

function createSignService(ctx: AppContext) {
  return {
    signAndSendTransaction: async (
      inputs: SolanaSignAndSendTransactionInput[],
      origin: string,
    ): Promise<SolanaSignAndSendTransactionOutput[]> => {
      return await withSigningAccounts(
        ctx,
        origin,
        inputs.map((input) => input.account.address),
        async (signers) => {
          const network = await getDbService().network.active()
          const rpc = createSolanaRpc(network.endpoint as ClusterUrl)
          const results: SolanaSignAndSendTransactionOutput[] = []

          for (const input of inputs) {
            const { keyPair } = requireSigner(signers, input.account.address)
            const decoded = getTransactionDecoder().decode(decodeTransportBytes(input.transaction))
            const transaction = await signTransaction([keyPair], decoded)
            assertIsSendableTransaction(transaction)
            const sendTransaction = sendTransactionWithoutConfirmingFactory({ rpc })
            await sendTransaction(transaction, { commitment: 'confirmed' })

            results.push({
              signature: new Uint8Array(getBase58Encoder().encode(getSignatureFromTransaction(transaction))),
            })
          }

          return results
        },
      )
    },
    signIn: async (inputs: SolanaSignInInput[], origin: string): Promise<SolanaSignInOutput[]> => {
      const granted = await grantedAddress(origin)
      if (!granted) {
        throw new Error(`origin is not connected: ${origin}`)
      }
      const host = new URL(origin).host
      return await withSigningAccounts(
        ctx,
        origin,
        inputs.map((input) => input.address || granted),
        async (signers) => {
          const results: SolanaSignInOutput[] = []

          for (const input of inputs) {
            const addr = input.address || granted
            if (input.domain && input.domain !== host) {
              throw new Error(`sign-in domain ${input.domain} does not match origin ${origin}`)
            }
            const { account, keyPair } = requireSigner(signers, addr)
            const signedMessage = createSignInMessage({
              ...input,
              address: addr,
              domain: input.domain || host,
            })
            const signature = await signBytes(keyPair.privateKey, signedMessage)

            results.push({
              account: {
                address: account.publicKey,
                chains: SOLANA_CHAINS,
                features: [SolanaSignAndSendTransaction, SolanaSignIn, SolanaSignMessage, SolanaSignTransaction],
                publicKey: getAddressEncoder().encode(address(account.publicKey)),
              },
              signature,
              signatureType: 'ed25519',
              signedMessage,
            })
          }

          return results
        },
      )
    },
    signMessage: async (inputs: SolanaSignMessageInput[], origin: string): Promise<SolanaSignMessageOutput[]> => {
      return await withSigningAccounts(
        ctx,
        origin,
        inputs.map((input) => input.account.address),
        async (signers) => {
          const results: SolanaSignMessageOutput[] = []

          for (const input of inputs) {
            const signedMessage = decodeTransportBytes(input.message)
            // Re-checked here even though the action gates the same way: the
            // sign service is the last line of defense.
            assertMessageSignable(signedMessage)
            const { keyPair } = requireSigner(signers, input.account.address)
            const signature = await signBytes(keyPair.privateKey, signedMessage)

            results.push({
              signature,
              signatureType: 'ed25519',
              signedMessage,
            })
          }

          return results
        },
      )
    },
    signTransaction: async (
      inputs: SolanaSignTransactionInput[],
      origin: string,
    ): Promise<SolanaSignTransactionOutput[]> => {
      return await withSigningAccounts(
        ctx,
        origin,
        inputs.map((input) => input.account.address),
        async (signers) => {
          const results: SolanaSignTransactionOutput[] = []

          for (const input of inputs) {
            const { keyPair } = requireSigner(signers, input.account.address)
            const decoded = getTransactionDecoder().decode(decodeTransportBytes(input.transaction))
            const signed = await signTransaction([keyPair], decoded)
            results.push({
              signedTransaction: new Uint8Array(getTransactionEncoder().encode(signed)),
            })
          }

          return results
        },
      )
    },
  }
}

type SignService = ReturnType<typeof createSignService>

const signServiceKey = 'SignService' as ProxyServiceKey<SignService>
let signService: SignService | undefined

export function getSignService(): ProxyService<SignService> {
  return (signService ?? createProxyService(signServiceKey)) as ProxyService<SignService>
}

export function registerSignService(ctx: AppContext): SignService {
  signService = createSignService(ctx)
  registerService(signServiceKey, signService)
  return signService
}
