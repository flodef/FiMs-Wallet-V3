import type { Wallet } from '@workspace/db/wallet/wallet'
import { useTranslation } from '@workspace/i18n'
import { Button } from '@workspace/ui/components/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu'
import { UiConfirm } from '@workspace/ui/components/ui-confirm'
import { UiIcon } from '@workspace/ui/components/ui-icon'
import { Fragment, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { SettingsUiBottomSheetExportWalletMnemonic } from './settings-ui-bottom-sheet-export-wallet-mnemonic.tsx'
import { SettingsUiBottomSheetTransferWallet } from './settings-ui-bottom-sheet-transfer-wallet.tsx'

export interface SettingsUiWalletMenuProps {
  deleteItem: (item: Wallet) => Promise<void>
  isFirst?: boolean
  isLast?: boolean
  onMoveDown?: (item: Wallet) => Promise<void>
  onMoveUp?: (item: Wallet) => Promise<void>
  wallet: Wallet
}

export function SettingsUiWalletMenu({
  deleteItem,
  isFirst,
  isLast,
  onMoveDown,
  onMoveUp,
  wallet,
}: SettingsUiWalletMenuProps) {
  const { t } = useTranslation('settings')
  const { pathname: from } = useLocation()
  const [openDelete, setOpenDelete] = useState(false)
  const [openExport, setOpenExport] = useState(false)
  const [openTransfer, setOpenTransfer] = useState(false)
  return (
    <Fragment>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon" variant="outline">
            <UiIcon icon="menu" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem asChild className="cursor-pointer">
            <Link state={{ from }} to={`/settings/wallets/${wallet.id}/edit`}>
              {t(($) => $.actionEditWallet)}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem
            className="cursor-pointer"
            disabled={isFirst || !onMoveUp}
            onClick={() => onMoveUp?.(wallet)}
          >
            {t(($) => $.actionMoveWalletUp)}
          </DropdownMenuItem>
          <DropdownMenuItem
            className="cursor-pointer"
            disabled={isLast || !onMoveDown}
            onClick={() => onMoveDown?.(wallet)}
          >
            {t(($) => $.actionMoveWalletDown)}
          </DropdownMenuItem>
          {wallet.derivationPath.length ? (
            <DropdownMenuItem className="cursor-pointer" onClick={() => setOpenExport(true)}>
              {t(($) => $.exportMnemonic)}
            </DropdownMenuItem>
          ) : null}
          {wallet.externalWallet ? null : (
            <DropdownMenuItem className="cursor-pointer" onClick={() => setOpenTransfer(true)}>
              {t(($) => $.transferWalletMenu)}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem className="cursor-pointer" onClick={() => setOpenDelete(true)}>
            {t(($) => $.actionDeleteWallet)}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <SettingsUiBottomSheetExportWalletMnemonic open={openExport} setOpen={setOpenExport} wallet={wallet} />
      <SettingsUiBottomSheetTransferWallet open={openTransfer} setOpen={setOpenTransfer} wallet={wallet} />
      <UiConfirm
        action={() => deleteItem(wallet)}
        actionLabel={t(($) => $.actionDelete)}
        actionVariant="destructive"
        description={t(($) => $.walletDeleteDescription)}
        onOpenChange={setOpenDelete}
        open={openDelete}
        title={t(($) => $.walletDeleteTitle)}
      />
    </Fragment>
  )
}
