import type { Wallet } from '@workspace/db/wallet/wallet'
import { useAccountsForWalletLive } from '@workspace/db-react/use-accounts-for-wallet-live'
import { useTranslation } from '@workspace/i18n'
import { UiBottomSheet } from '@workspace/ui/components/ui-bottom-sheet'
import { UiQrCode } from '@workspace/ui/components/ui-qr-code'
import { UiTextCopyButton } from '@workspace/ui/components/ui-text-copy-button'
import { toastError } from '@workspace/ui/lib/toast-error'
import { useVaultUnlockDialog } from '@workspace/vault-react/vault-unlock-provider'
import { useRef, useState } from 'react'
import { useWalletTransferExport } from '../data-access/use-wallet-transfer-export.tsx'
import { SettingsUiExportConfirm } from './settings-ui-export-confirm.tsx'

// Jupiter Sync-style transfer: the QR carries the wallet secrets to another
// device — nothing goes through a server. It grants full access to the
// funds, so it gets the same unlock + explicit-show treatment as the
// recovery phrase export.
export function SettingsUiBottomSheetTransferWallet({
  wallet,
  open,
  setOpen,
}: {
  wallet: Wallet
  open: boolean
  setOpen: (value: boolean) => void
}) {
  const { t } = useTranslation('settings')
  const { requestUnlock } = useVaultUnlockDialog()
  const accounts = useAccountsForWalletLive({ walletId: wallet.id })
  const exportTransfer = useWalletTransferExport()
  const sessionRef = useRef(0)
  const [code, setCode] = useState<string>()

  function handleOpenChange(value: boolean) {
    if (!value) {
      sessionRef.current += 1
      setCode(undefined)
    }
    setOpen(value)
  }

  async function handleShowTransfer() {
    const session = sessionRef.current
    const unlocked = await requestUnlock({
      mode: wallet.protectionMode,
      reason: 'exportWalletMnemonic',
      walletId: wallet.id,
    })
    if (!unlocked) {
      return
    }
    if (session !== sessionRef.current) {
      return
    }

    try {
      const result = await exportTransfer(wallet, accounts)
      if (session === sessionRef.current) {
        setCode(result)
      }
    } catch (caught) {
      if (session === sessionRef.current) {
        toastError(caught instanceof Error ? caught.message : `${caught}`)
      }
    }
  }

  return (
    <UiBottomSheet
      description={t(($) => $.transferWalletDescription)}
      onOpenChange={handleOpenChange}
      open={open}
      title={t(($) => $.transferWalletTitle)}
    >
      <div className="px-4 pb-4">
        {code?.length ? (
          <div className="space-y-3 text-center">
            <div className="mx-auto aspect-square w-full max-w-70 p-3">
              <UiQrCode content={code} />
            </div>
            <p className="text-muted-foreground text-xs">{t(($) => $.transferWalletWarning)}</p>
            <UiTextCopyButton
              label={t(($) => $.transferWalletCopy)}
              text={code}
              toast={t(($) => $.transferWalletCopied)}
            />
          </div>
        ) : (
          <SettingsUiExportConfirm confirm={handleShowTransfer} label={t(($) => $.transferWalletShow)} />
        )}
      </div>
    </UiBottomSheet>
  )
}
