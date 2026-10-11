import {
  FIMS_COINBASE_REFERRAL_URL,
  FIMS_JUPITER_SPEND_REFERRAL_CODE,
  FIMS_JUPITER_SPEND_REFERRAL_URL,
  FIMS_NEXO_REFERRAL_URL,
} from '@workspace/feature-fims/fims-constants'
import { useTranslation } from '@workspace/i18n'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@workspace/ui/components/table'
import { UiIcon } from '@workspace/ui/components/ui-icon'
import { UiTextCopyButton } from '@workspace/ui/components/ui-text-copy-button'
import type { ReactNode } from 'react'

const YES = <UiIcon className="size-4 text-green-500" icon="check" />
const NO = <UiIcon className="size-4 text-muted-foreground" icon="x" />

// Side-by-side comparison of the two off-ramps offered in the withdrawal
// settings, with the FiMs referral links. The Jupiter go.link does not
// always prefill the signup code, so the code is shown for manual entry.
export function SettingsUiWithdrawalCompare() {
  const { t } = useTranslation('settings')

  const rows: { coinbase: ReactNode; jupiter: ReactNode; label: string; nexo: ReactNode }[] = [
    {
      coinbase: t(($) => $.pageGeneralWithdrawalCompareFree),
      jupiter: '20 €**',
      label: t(($) => $.pageGeneralWithdrawalComparePhysicalCard),
      nexo: YES,
    },
    { coinbase: YES, jupiter: YES, label: t(($) => $.pageGeneralWithdrawalCompareVirtualCard), nexo: YES },
    {
      coinbase: NO,
      jupiter: t(($) => $.pageGeneralWithdrawalCompareCashbackValue),
      label: t(($) => $.pageGeneralWithdrawalCompareCashback),
      nexo: t(($) => $.pageGeneralWithdrawalCompareNexoCashback),
    },
    { coinbase: '1:1', jupiter: NO, label: t(($) => $.pageGeneralWithdrawalCompareEurc), nexo: YES },
    { coinbase: YES, jupiter: NO, label: t(($) => $.pageGeneralWithdrawalCompareBank), nexo: YES },
    {
      coinbase: t(($) => $.pageGeneralWithdrawalCompareEasy),
      jupiter: t(($) => $.pageGeneralWithdrawalCompareHard),
      label: t(($) => $.pageGeneralWithdrawalCompareEuLaw),
      nexo: t(($) => $.pageGeneralWithdrawalCompareNexoLaw),
    },
  ]

  return (
    <div className="space-y-2">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="whitespace-normal">{t(($) => $.pageGeneralWithdrawalCompare)}</TableHead>
            <TableHead className="whitespace-normal">Coinbase</TableHead>
            <TableHead className="whitespace-normal">Jupiter Spend</TableHead>
            <TableHead className="whitespace-normal">Nexo</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.label}>
              <TableCell className="whitespace-normal">{row.label}</TableCell>
              <TableCell className="whitespace-normal">{row.coinbase}</TableCell>
              <TableCell className="whitespace-normal">{row.jupiter}</TableCell>
              <TableCell className="whitespace-normal">{row.nexo}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="text-muted-foreground text-xs">{t(($) => $.pageGeneralWithdrawalCompareCashbackNote)}</p>
      <p className="text-muted-foreground text-xs">{t(($) => $.pageGeneralWithdrawalCompareCardNote)}</p>
      <p className="text-muted-foreground text-sm">{t(($) => $.pageGeneralWithdrawalCompareSummary)}</p>
      <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-sm">
        <a className="text-primary underline" href={FIMS_COINBASE_REFERRAL_URL} rel="noreferrer" target="_blank">
          {t(($) => $.pageGeneralWithdrawalExchangeSignup)}
        </a>
        <span aria-hidden>·</span>
        <a className="text-primary underline" href={FIMS_JUPITER_SPEND_REFERRAL_URL} rel="noreferrer" target="_blank">
          {t(($) => $.pageGeneralWithdrawalSpendSignup)}
        </a>
        <span>{t(($) => $.pageGeneralWithdrawalSpendReferralHint)}</span>
        <UiTextCopyButton
          label={FIMS_JUPITER_SPEND_REFERRAL_CODE}
          size="sm"
          text={FIMS_JUPITER_SPEND_REFERRAL_CODE}
          toast={t(($) => $.pageGeneralWithdrawalSpendReferralCopied)}
        />
        <span aria-hidden>·</span>
        <a className="text-primary underline" href={FIMS_NEXO_REFERRAL_URL} rel="noreferrer" target="_blank">
          {t(($) => $.pageGeneralWithdrawalSignup, { provider: 'Nexo' })}
        </a>
      </div>
    </div>
  )
}
