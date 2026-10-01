import type { Account } from '@workspace/db/account/account'
import { useTranslation } from '@workspace/i18n'
import { Button } from '@workspace/ui/components/button'
import { Input } from '@workspace/ui/components/input'
import { Label } from '@workspace/ui/components/label'
import { Switch } from '@workspace/ui/components/switch'
import { UiCard } from '@workspace/ui/components/ui-card'
import { UiLoader } from '@workspace/ui/components/ui-loader'
import { toastError } from '@workspace/ui/lib/toast-error'
import { toastSuccess } from '@workspace/ui/lib/toast-success'
import { useState } from 'react'
import { useFimsUserUpdate } from './data-access/use-fims.tsx'
import type { FimsUser } from './fims-api.ts'
import { formatDateTime } from './fims-format.ts'

const PROFILE_EDIT_COOLDOWN_MS = 24 * 60 * 60 * 1000

// Self-service profile edit (name + privacy). The API enforces a once-a-day
// limit for member edits — the UI mirrors the cooldown so members see why the
// button is disabled instead of getting a 429.
export function FimsUiProfileEdit({ account, member }: { account: Account; member: FimsUser }) {
  const { t } = useTranslation('fims')
  const update = useFimsUserUpdate(account, member.id)

  const [name, setName] = useState(member.name)
  const [isPublic, setIsPublic] = useState(member.isPublic)

  const nextEditAt = member.profileUpdatedAt
    ? new Date(member.profileUpdatedAt).getTime() + PROFILE_EDIT_COOLDOWN_MS
    : 0
  const coolingDown = Date.now() < nextEditAt
  const dirty = name.trim() !== member.name || isPublic !== member.isPublic
  const canEdit = account.type !== 'Watched'
  const canSubmit = canEdit && !coolingDown && dirty && name.trim().length > 0 && !update.isPending

  const handleSave = async () => {
    try {
      const patch: { isPublic?: boolean; name?: string } = {}
      if (name.trim() !== member.name) patch.name = name.trim()
      if (isPublic !== member.isPublic) patch.isPublic = isPublic
      await update.mutateAsync(patch)
      toastSuccess(t(($) => $.profileSaved))
    } catch (error) {
      toastError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <UiCard title={t(($) => $.profileTitle)}>
      <div className="space-y-4">
        <div className="space-y-2">
          <Label>{t(($) => $.profileName)}</Label>
          <Input disabled={coolingDown || !canEdit} onChange={(e) => setName(e.target.value)} value={name} />
        </div>
        <div className="flex items-center justify-between">
          <Label>{t(($) => $.profilePublic)}</Label>
          <Switch checked={isPublic} disabled={coolingDown || !canEdit} onCheckedChange={setIsPublic} />
        </div>
        <p className="text-muted-foreground text-xs">
          {coolingDown
            ? t(($) => $.profileCooldown, { date: formatDateTime(new Date(nextEditAt).toISOString()) })
            : t(($) => $.profileCooldownHint)}
        </p>
        <div className="flex justify-end">
          <Button disabled={!canSubmit} onClick={handleSave}>
            {update.isPending ? <UiLoader className="size-4" /> : null}
            {t(($) => $.profileSave)}
          </Button>
        </div>
      </div>
    </UiCard>
  )
}
