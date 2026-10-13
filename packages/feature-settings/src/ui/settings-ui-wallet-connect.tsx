import type { Address } from '@solana/kit'
import type { Wallet as StandardWallet } from '@wallet-standard/core'
import { StandardConnect, type StandardConnectFeature } from '@wallet-standard/features'
import { useAccountCreate } from '@workspace/db-react/use-account-create'
import { useAccountSetActive } from '@workspace/db-react/use-account-set-active'
import { useAccountUpdate } from '@workspace/db-react/use-account-update'
import { useAccountsLive } from '@workspace/db-react/use-accounts-live'
import { useDetectedWallets } from '@workspace/db-react/use-connected-wallet-signer'
import { useWalletCreate } from '@workspace/db-react/use-wallet-create'
import { useWalletLive } from '@workspace/db-react/use-wallet-live'
import { useWalletUpdate } from '@workspace/db-react/use-wallet-update'
import { useTranslation } from '@workspace/i18n'
import { Button } from '@workspace/ui/components/button'
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@workspace/ui/components/item'
import { Spinner } from '@workspace/ui/components/spinner'
import { ellipsify } from '@workspace/ui/lib/ellipsify'
import { toastError } from '@workspace/ui/lib/toast-error'
import { toastSuccess } from '@workspace/ui/lib/toast-success'
import { useState } from 'react'

// External wallet connect (Solflare, Phantom, Jupiter…): each detected
// wallet-standard wallet gets a Connect button. Connected accounts are
// grouped under a dedicated wallet row and sign through the external
// wallet — no keys are imported.
export function SettingsUiWalletConnect({ onConnected }: { onConnected?: () => void } = {}) {
  const { t } = useTranslation('settings')
  const wallets = useWalletLive()
  const accounts = useAccountsLive()
  const createWallet = useWalletCreate()
  const updateWallet = useWalletUpdate()
  const createAccount = useAccountCreate()
  const updateAccount = useAccountUpdate()
  const setActive = useAccountSetActive()
  const [pending, setPending] = useState<string>()
  // 'FiMs' is the wallet we register for dApps — not an external wallet.
  const detected = useDetectedWallets().filter((wallet) => wallet.features[StandardConnect])

  async function connect(wallet: StandardWallet) {
    setPending(wallet.name)
    try {
      const connectFeature = wallet.features[StandardConnect] as
        | StandardConnectFeature[typeof StandardConnect]
        | undefined
      if (!connectFeature) {
        return
      }
      const { accounts: walletAccounts } = await connectFeature.connect()
      if (!walletAccounts.length) {
        throw new Error('No account authorized')
      }
      // Legacy rows were written before externalWallet was persisted — they
      // are recognizable by an empty derivationPath and the wallet name.
      const existingWallet =
        wallets.find((item) => item.externalWallet === wallet.name) ??
        wallets.find((item) => item.derivationPath === '' && item.name === wallet.name.slice(0, 20))
      if (existingWallet && !existingWallet.externalWallet) {
        await updateWallet.mutateAsync({ id: existingWallet.id, input: { externalWallet: wallet.name } })
      }
      const walletId =
        existingWallet?.id ??
        (await createWallet.mutateAsync({
          input: {
            derivationPath: '',
            externalWallet: wallet.name,
            mnemonic: '',
            name: wallet.name.slice(0, 20),
            protection: { mode: 'unsecured' },
          },
        }))
      // Reconnecting a wallet restores the link on any account that was
      // disconnected (Watched) instead of duplicating it; genuinely new
      // addresses get a fresh Connected account.
      let lastAddedId: string | undefined
      for (const walletAccount of walletAccounts) {
        const publicKey = walletAccount.address as Address
        const existing = accounts.find((a) => a.walletId === walletId && a.publicKey === publicKey)
        if (existing?.type === 'Connected') {
          continue
        }
        if (existing) {
          await updateAccount.mutateAsync({
            id: existing.id,
            input: { externalWallet: wallet.name, type: 'Connected' },
          })
          lastAddedId = existing.id
          continue
        }
        lastAddedId = await createAccount.mutateAsync({
          input: {
            externalWallet: wallet.name,
            name: ellipsify(publicKey),
            publicKey,
            type: 'Connected',
            walletId,
          },
        })
      }
      // The connect is an intent to use the wallet — activate it so it does
      // not sit inert while another account stays active.
      const targetId = lastAddedId ?? accounts.find((a) => a.walletId === walletId)?.id
      if (targetId) {
        await setActive.mutateAsync({ id: targetId })
      }
      toastSuccess(t(($) => $.walletConnectSuccess))
      onConnected?.()
    } catch (error) {
      toastError(`${error}`)
    } finally {
      setPending(undefined)
    }
  }

  return (
    <div className="space-y-2">
      {detected.map((wallet) => (
        <Item key={wallet.name} variant="outline">
          <ItemMedia variant="icon">
            {wallet.icon ? (
              // External wallet icon (data URI provided by wallet-standard)
              // eslint-disable-next-line @next/next/no-img-element
              <img alt="" className="size-4" src={wallet.icon} />
            ) : null}
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{wallet.name}</ItemTitle>
          </ItemContent>
          <ItemActions>
            <Button
              className="cursor-pointer"
              disabled={pending !== undefined}
              onClick={() => connect(wallet)}
              size="sm"
              variant="outline"
            >
              {pending === wallet.name ? <Spinner /> : t(($) => $.actionConnect)}
            </Button>
          </ItemActions>
        </Item>
      ))}
      {detected.length ? null : (
        <Item variant="outline">
          <ItemContent>
            <ItemDescription>{t(($) => $.walletConnectNoneDetected)}</ItemDescription>
          </ItemContent>
        </Item>
      )}
    </div>
  )
}
