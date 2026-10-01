import type { Account } from '@workspace/db/account/account'
import { useTranslation } from '@workspace/i18n'
import { Button } from '@workspace/ui/components/button'
import { UiCard } from '@workspace/ui/components/ui-card'
import { UiIcon } from '@workspace/ui/components/ui-icon'
import { UiLoader } from '@workspace/ui/components/ui-loader'
import { toastError } from '@workspace/ui/lib/toast-error'
import { toastSuccess } from '@workspace/ui/lib/toast-success'
import { useEffect, useState } from 'react'
import { useFimsConvert, useFimsUserUpdate } from './data-access/use-fims.tsx'
import { useFimsCurrency } from './data-access/use-fims-currency.tsx'
import type { FimsUser } from './fims-api.ts'
import { FIMS_FEE_RATE } from './fims-constants.ts'
import type { FimsPosition } from './fims-positions.ts'
import { computeRebalancePlan } from './fims-risk.ts'

// Member-chosen risky/safe split: shows the current allocation, lets the member
// set a target, and proposes (and executes) the corrective conversion when the
// portfolio drifts too far from it.
export function FimsUiRebalance({
  account,
  member,
  positions,
}: {
  account: Account
  member: FimsUser
  positions: FimsPosition[]
}) {
  const { t } = useTranslation('fims')
  const { format } = useFimsCurrency()
  const update = useFimsUserUpdate(account, member.id)
  const convert = useFimsConvert(account)
  const canSign = account.type !== 'Watched'

  const [target, setTarget] = useState<number>(member.riskTarget ?? 50)
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    if (member.riskTarget != null) setTarget(member.riskTarget)
  }, [member.riskTarget])

  const plan = member.riskTarget != null ? computeRebalancePlan(positions, member.riskTarget / 100) : null

  const saveTarget = async () => {
    try {
      await update.mutateAsync({ riskTarget: target })
      setEditing(false)
      toastSuccess(t(($) => $.rebalanceTargetSaved))
    } catch (error) {
      toastError(error instanceof Error ? error.message : String(error))
    }
  }

  const runRebalance = async () => {
    if (!plan?.fromSymbol || !plan.toSymbol) return
    try {
      await convert.mutateAsync({
        eurAmount: Math.round(plan.driftValue * 100) / 100,
        fromToken: plan.fromSymbol,
        toToken: plan.toSymbol,
      })
      toastSuccess(t(($) => $.rebalanceDone))
    } catch (error) {
      toastError(error instanceof Error ? error.message : String(error))
    }
  }

  const riskyPct = plan ? plan.currentRiskyRatio * 100 : null

  return (
    <UiCard
      action={
        canSign ? (
          editing ? (
            <Button disabled={update.isPending} onClick={saveTarget} size="sm" variant="outline">
              {update.isPending ? <UiLoader className="size-4" /> : null}
              {t(($) => $.rebalanceSave)}
            </Button>
          ) : (
            <Button onClick={() => setEditing(true)} size="sm" variant="outline">
              <UiIcon className="size-4" icon="edit" />
              {t(($) => $.rebalanceEdit)}
            </Button>
          )
        ) : null
      }
      title={t(($) => $.rebalanceTitle)}
    >
      <div className="space-y-3">
        {editing ? (
          <div className="space-y-2">
            <div className="text-muted-foreground text-sm">{t(($) => $.rebalanceTargetHint)}</div>
            <div className="flex items-center gap-3">
              <input
                className="flex-1 accent-primary"
                max={100}
                min={0}
                onChange={(e) => setTarget(Number(e.target.value))}
                step={5}
                type="range"
                value={target}
              />
              <span className="w-24 text-right font-semibold text-sm">
                {target}/{100 - target}
              </span>
            </div>
            <div className="flex justify-between text-muted-foreground text-xs">
              <span>{t(($) => $.rebalanceSafe)}</span>
              <span>{t(($) => $.rebalanceRisky)}</span>
            </div>
          </div>
        ) : member.riskTarget != null ? (
          <div className="text-muted-foreground text-sm">
            {t(($) => $.rebalanceTarget, { risky: member.riskTarget, safe: 100 - member.riskTarget })}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">{t(($) => $.rebalanceNoTarget)}</p>
        )}

        {plan ? (
          <>
            <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-red-400" style={{ width: `${riskyPct}%` }} />
              <div className="h-full bg-green-500" style={{ width: `${100 - (riskyPct ?? 0)}%` }} />
            </div>
            <div className="flex justify-between text-muted-foreground text-xs">
              <span>
                {t(($) => $.rebalanceRisky)} {(riskyPct ?? 0).toFixed(0)}% · {format(plan.riskyValue)}
              </span>
              <span>
                {t(($) => $.rebalanceSafe)} {(100 - (riskyPct ?? 0)).toFixed(0)}% · {format(plan.safeValue)}
              </span>
            </div>
          </>
        ) : null}

        {plan?.needsRebalance && plan.fromSymbol && plan.toSymbol ? (
          <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
            <p>
              {t(($) => $.rebalanceDrift, {
                drift: Math.abs(plan.driftRatio * 100).toFixed(1),
              })}
            </p>
            <p className="mt-1 font-medium">
              {t(($) => $.rebalanceProposal, {
                amount: format(plan.driftValue),
                from: plan.fromSymbol,
                to: plan.toSymbol,
              })}
            </p>
            <p className="mt-1 text-muted-foreground text-xs">
              {t(($) => $.rebalanceFee, { amount: format(plan.driftValue * FIMS_FEE_RATE) })}
            </p>
            <div className="mt-2 flex justify-end">
              <Button disabled={!canSign || convert.isPending} onClick={runRebalance} size="sm">
                {convert.isPending ? <UiLoader className="size-4" /> : null}
                {t(($) => $.rebalanceRun)}
              </Button>
            </div>
          </div>
        ) : plan ? (
          <p className="text-muted-foreground text-xs">{t(($) => $.rebalanceBalanced)}</p>
        ) : null}
      </div>
    </UiCard>
  )
}
