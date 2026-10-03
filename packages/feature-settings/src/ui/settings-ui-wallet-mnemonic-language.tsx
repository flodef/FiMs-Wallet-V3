import type { MnemonicLanguage } from '@workspace/keypair/get-mnemonic-wordlist'
import { Button } from '@workspace/ui/components/button'
import { ButtonGroup } from '@workspace/ui/components/button-group'

export function SettingsUiWalletMnemonicLanguage({
  language,
  setLanguage,
}: {
  language: MnemonicLanguage
  setLanguage: (language: MnemonicLanguage) => void
}) {
  return (
    <ButtonGroup>
      <Button onClick={() => setLanguage('en')} variant={language === 'en' ? 'secondary' : 'outline'}>
        English
      </Button>
      <Button onClick={() => setLanguage('fr')} variant={language === 'fr' ? 'secondary' : 'outline'}>
        Français
      </Button>
    </ButtonGroup>
  )
}
