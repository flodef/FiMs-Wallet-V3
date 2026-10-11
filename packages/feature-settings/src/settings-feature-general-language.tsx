import { useSetting } from '@workspace/db-react/use-setting'
import { i18n, LANGUAGE_AUTO, resolveLanguage, useSupportedLanguages, useTranslation } from '@workspace/i18n'
import { Label } from '@workspace/ui/components/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select'
import { useId } from 'react'

export function SettingsFeatureGeneralLanguage() {
  const { t } = useTranslation('settings')
  const languageId = useId()
  const [language, setLanguage] = useSetting('language')
  const supportedLanguages = useSupportedLanguages()

  async function handleLanguageChange(newLanguage: string) {
    await setLanguage(newLanguage)
    await i18n.changeLanguage(resolveLanguage(newLanguage))
  }

  const selected = language ?? LANGUAGE_AUTO

  return (
    <div className="space-y-2">
      <Label htmlFor={languageId}>{t(($) => $.pageGeneralLanguage)}</Label>
      <Select onValueChange={handleLanguageChange} value={selected}>
        <SelectTrigger id={languageId}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={LANGUAGE_AUTO}>{t(($) => $.pageGeneralLanguageAuto)}</SelectItem>
          {Object.entries(supportedLanguages).map(([code, name]) => (
            <SelectItem disabled={selected === code} key={code} value={code}>
              {name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
