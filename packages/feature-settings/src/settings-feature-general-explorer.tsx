import { useSetting } from '@workspace/db-react/use-setting'
import { useTranslation } from '@workspace/i18n'
import { type ExplorerProvider, explorerProviders, getExplorerName } from '@workspace/solana-client/get-explorer-url'
import { Label } from '@workspace/ui/components/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select'
import { useId } from 'react'

export function SettingsFeatureGeneralExplorer() {
  const { t } = useTranslation('settings')
  const explorerId = useId()
  const [explorer, setExplorer] = useSetting('chainExplorer')
  const value = explorerProviders.includes(explorer as ExplorerProvider) ? (explorer as ExplorerProvider) : 'solana'

  return (
    <div className="space-y-2">
      <Label htmlFor={explorerId}>{t(($) => $.pageGeneralExplorer)}</Label>
      <Select onValueChange={setExplorer} value={value}>
        <SelectTrigger id={explorerId}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {explorerProviders.map((provider) => (
            <SelectItem disabled={value === provider} key={provider} value={provider}>
              {getExplorerName(provider)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
