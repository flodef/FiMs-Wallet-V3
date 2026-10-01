import { useTranslation } from '@workspace/i18n'
import type { FimsTransaction } from './fims-api.ts'
import { getFimsTransactionType } from './fims-transaction-type.ts'

export function FimsTxTypeLabel({ transaction }: { transaction: FimsTransaction }) {
  const { t } = useTranslation('fims')
  switch (getFimsTransactionType(transaction)) {
    case 'cex_in':
      return t(($) => $.txTypeCexIn)
    case 'cex_out':
      return t(($) => $.txTypeCexOut)
    case 'conversion':
      return t(($) => $.txTypeConversion)
    case 'donation':
      return t(($) => $.txTypeDonation)
    case 'payment':
      return t(($) => $.txTypePayment)
    case 'tontine':
      return t(($) => $.txTypeTontine)
    case 'withdrawal':
      return t(($) => $.txTypeWithdrawal)
    default:
      return t(($) => $.txTypeDeposit)
  }
}
