import { useTranslation } from '@workspace/i18n'
import { Button } from '@workspace/ui/components/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@workspace/ui/components/dialog'
import { Input } from '@workspace/ui/components/input'
import { Label } from '@workspace/ui/components/label'
import { useId } from 'react'
import type { RequestSignApproval } from '../data-access/use-request-sign-approval.tsx'

export function RequestUiUnlockDialog({ approval }: { approval: RequestSignApproval }) {
  const credentialId = useId()
  const { t } = useTranslation('request')
  const { actions, state } = approval

  return (
    <Dialog onOpenChange={actions.changeOpen} open={state.isOpen}>
      <DialogContent>
        <form className="space-y-4" onSubmit={actions.submitUnlock}>
          <DialogHeader>
            <DialogTitle>{t(($) => $.unlockTitle)}</DialogTitle>
            <DialogDescription>{t(($) => $.unlockDescription)}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor={credentialId}>
              {state.mode === 'password'
                ? t(($) => $.unlockPasswordLabel)
                : state.mode === 'pin'
                  ? t(($) => $.unlockPinLabel)
                  : t(($) => $.unlockWalletLabel)}
            </Label>
            <Input
              autoComplete={state.mode === 'password' ? 'current-password' : 'off'}
              id={credentialId}
              inputMode={state.mode === 'pin' ? 'numeric' : undefined}
              onChange={(event) => actions.changeCredential(event.target.value)}
              pattern={state.mode === 'pin' ? '[0-9]*' : undefined}
              type={state.mode === 'pin' ? 'text' : 'password'}
              value={state.credential}
            />
          </div>
          {state.error ? <p className="text-destructive text-sm">{state.error}</p> : null}
          <DialogFooter>
            <Button disabled={state.isUnlocking} onClick={actions.cancelUnlock} type="button" variant="outline">
              {t(($) => $.unlockCancel)}
            </Button>
            <Button disabled={state.isUnlocking} type="submit" variant="destructive">
              {state.isUnlocking ? t(($) => $.unlockSubmitting) : t(($) => $.unlockSubmit)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
