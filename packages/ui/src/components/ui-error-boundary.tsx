import { useTranslation } from '@workspace/i18n'
import { useState } from 'react'
import { isRouteErrorResponse, Navigate, useRouteError } from 'react-router'
import { cn } from '../lib/utils.ts'
import { Button } from './button.tsx'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './collapsible.tsx'
import { UiEmpty } from './ui-empty.tsx'
import { UiIcon } from './ui-icon.tsx'

export function UiErrorBoundary() {
  const { t } = useTranslation('ui')
  const error = useRouteError()
  const isError = error instanceof Error

  // Thrown when the last wallet/account vanished mid-session (e.g. the active
  // external wallet was disconnected) — a redirect, not a bug page.
  if (isError && error.name === 'NoActiveAccountError') {
    return <Navigate replace to="/onboarding" />
  }

  const stack = isError ? error.stack : null
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : isError
      ? error.message
      : JSON.stringify(error)

  const description = message ?? t(($) => $.errorUnknown)
  const title = t(($) => $.errorTitle)

  return (
    <div className={cn('flex h-full w-full items-center justify-center px-6')}>
      <UiEmpty className="" description={description} icon="bug" title={title}>
        <UiErrorBoundarySupport />
        <Button onClick={() => window.location.reload()} variant="secondary">
          <span>{t(($) => $.actionRefresh)}</span>
          <UiIcon className="size-3" icon="refresh" />
        </Button>

        {stack ? <UiErrorBoundaryStack stack={stack} /> : null}
      </UiEmpty>
    </div>
  )
}

function UiErrorBoundaryStack({ stack }: { stack: string }) {
  const { t } = useTranslation('ui')
  const [showStack, setShowStack] = useState(false)

  return (
    <Collapsible className="w-full" onOpenChange={setShowStack} open={showStack}>
      <CollapsibleTrigger asChild>
        <Button variant="secondary">
          <span>{showStack ? t(($) => $.actionHideStack) : t(($) => $.actionShowStack)}</span>
          <UiIcon icon="chevronsUpDown" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-6">
        <pre className="w-full whitespace-pre-wrap text-left text-[9px]">{stack}</pre>
      </CollapsibleContent>
    </Collapsible>
  )
}

function UiErrorBoundarySupport() {
  const { t } = useTranslation('ui')
  return (
    <div>
      <a
        className="hover:underline"
        href="https://github.com/flodef/FiMs-Wallet-V3/issues/new"
        rel="noopener noreferrer"
        target="_blank"
      >
        {t(($) => $.errorSupport)}
      </a>
    </div>
  )
}
