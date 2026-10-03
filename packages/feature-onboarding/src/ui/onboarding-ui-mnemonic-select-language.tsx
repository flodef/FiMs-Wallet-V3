import type { MnemonicLanguage } from '@workspace/keypair/get-mnemonic-wordlist'
import { ToggleGroup, ToggleGroupItem } from '@workspace/ui/components/toggle-group'

export function OnboardingUiMnemonicSelectLanguage({
  language,
  setLanguage,
}: {
  language: MnemonicLanguage
  setLanguage: (value: MnemonicLanguage) => void
}) {
  return (
    <ToggleGroup
      className="w-full"
      onValueChange={(value) => setLanguage(value as MnemonicLanguage)}
      type="single"
      value={language}
      variant="outline"
    >
      <ToggleGroupItem disabled={language === 'en'} value="en">
        English
      </ToggleGroupItem>
      <ToggleGroupItem disabled={language === 'fr'} value="fr">
        Français
      </ToggleGroupItem>
      <ToggleGroupItem disabled={language === 'es'} value="es">
        Español
      </ToggleGroupItem>
    </ToggleGroup>
  )
}
