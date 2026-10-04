import { useTranslation } from '@workspace/i18n'
import { SettingsUiWalletConnect } from './settings-ui-wallet-connect.tsx'
import { SettingsUiWalletCreateComingSoon } from './settings-ui-wallet-create-coming-soon.tsx'
import { SettingsUiWalletCreateHeader } from './settings-ui-wallet-create-header.tsx'
import { SettingsUiWalletCreateLink } from './settings-ui-wallet-create-link.tsx'

export function SettingsUiWalletCreateOptions() {
  const { t } = useTranslation('settings')
  return (
    <div className="space-y-2 md:space-y-6">
      <SettingsUiWalletCreateHeader icon="mnemonic" label={t(($) => $.walletCreateHeaderSeed)} />
      <SettingsUiWalletCreateLink
        description={t(($) => $.walletCreateGenerateDescription)}
        title={t(($) => $.walletCreateGenerateTitle)}
        to="/settings/wallets/generate"
      />
      <SettingsUiWalletCreateLink
        description={t(($) => $.walletCreateImportDescription)}
        title={t(($) => $.walletCreateImportTitle)}
        to="/settings/wallets/import"
      />
      <SettingsUiWalletCreateHeader icon="hardware" label={t(($) => $.walletCreateHeaderExternal)} />
      <SettingsUiWalletConnect />
      <SettingsUiWalletCreateComingSoon
        description={t(($) => $.walletCreateHardwareUnruggableDescription)}
        title={t(($) => $.walletCreateHardwareUnruggableTitle)}
      />
    </div>
  )
}
