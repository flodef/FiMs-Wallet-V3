import { useWalletDetermineName } from '@workspace/db-react/use-wallet-determine-name'
import { useWalletGenerateWithAccount } from '@workspace/db-react/use-wallet-generate-with-account'
import { useTranslation } from '@workspace/i18n'
import { generateMnemonic } from '@workspace/keypair/generate-mnemonic'
import type { MnemonicLanguage } from '@workspace/keypair/get-mnemonic-wordlist'
import { Alert, AlertDescription } from '@workspace/ui/components/alert'
import { UiCard } from '@workspace/ui/components/ui-card'
import { useVaultUnlockDialog } from '@workspace/vault-react/vault-unlock-provider'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { SettingsUiWalletFormGenerate } from './ui/settings-ui-wallet-form-generate.tsx'
import { SettingsUiWalletMnemonicLanguage } from './ui/settings-ui-wallet-mnemonic-language.tsx'
import { SettingsUiWalletMnemonicStrength } from './ui/settings-ui-wallet-mnemonic-strength.tsx'

export function SettingsFeatureWalletGenerate() {
  const { t } = useTranslation('settings')
  const generateWalletWithAccountMutation = useWalletGenerateWithAccount()
  const navigate = useNavigate()
  // English is the safe default: non-English BIP-39 wordlists are not widely
  // importable by other wallets, so FR/ES must be an explicit opt-in.
  const [language, setLanguage] = useState<MnemonicLanguage>('en')
  const [strength, setStrength] = useState<128 | 256>(128)
  const name = useWalletDetermineName()
  const mnemonic = useMemo(() => generateMnemonic({ language, strength }), [language, strength])
  const { requestUnlock } = useVaultUnlockDialog()

  return (
    <UiCard
      backButtonTo="/settings/wallets/create"
      contentProps={{ className: 'space-y-2 md:space-y-6' }}
      title={t(($) => $.walletPageGenerateTitle)}
    >
      <div className="flex items-center justify-between gap-2">
        <SettingsUiWalletMnemonicLanguage language={language} setLanguage={setLanguage} />
        <SettingsUiWalletMnemonicStrength setStrength={setStrength} strength={strength} />
      </div>
      {language !== 'en' ? (
        <Alert variant="warning">
          <AlertDescription>{t(($) => $.walletPageMnemonicLanguageWarning)}</AlertDescription>
        </Alert>
      ) : null}
      <SettingsUiWalletFormGenerate
        mnemonic={mnemonic}
        name={name}
        submit={async (input) => {
          const unlocked = await requestUnlock({ mode: 'password', reason: 'createWallet' })
          if (!unlocked) {
            return
          }
          await generateWalletWithAccountMutation.mutateAsync(input).then(async (walletId) => {
            await navigate(`/settings/wallets/${walletId}`)
          })
        }}
      />
    </UiCard>
  )
}
