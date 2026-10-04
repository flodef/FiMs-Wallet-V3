import { useAccountActive } from '@workspace/db-react/use-account-active'
import { useNetworkActive } from '@workspace/db-react/use-network-active'
import { useSetting } from '@workspace/db-react/use-setting'
import PortfolioModals, {
  type SendBlockContext,
  type SendFeeContext,
  type SendOverrideContext,
  type SendSolFee,
} from '@workspace/feature-portfolio/portfolio-modals'
import type { DestinationAccount } from '@workspace/feature-portfolio/ui/portfolio-ui-send-destination'
import { useTranslation } from '@workspace/i18n'
import { NATIVE_MINT } from '@workspace/solana-client/constants'
import { useGetTokenMetadataJupiter } from '@workspace/solana-client-react/use-get-token-metadata-jupiter'
import type { UiGroupedComboboxInputGroup } from '@workspace/ui/components/ui-grouped-combobox-input'
import { useMemo } from 'react'
import { useFimsAddressBook, useFimsMember, useFimsTokens } from './data-access/use-fims.tsx'
import { useFimsCurrency } from './data-access/use-fims-currency.tsx'
import { useFimsDebt } from './data-access/use-fims-debt.tsx'
import { useWithdrawalTargets } from './data-access/use-withdrawal-targets.tsx'
import { FIMS_DEMO_ADDRESS, FIMS_TONTINE_ADDRESS, FIMS_TREASURY_ADDRESS } from './fims-constants.ts'
import { FimsFeatureSendConvert } from './fims-feature-send-convert.tsx'
import { getFimsFeeRate, getFimsTontineRate } from './fims-fee-config.ts'

const SOL_LAMPORTS = 1_000_000_000

// Wraps the portfolio send/receive modals and injects the member's FiMs address
// book as an extra destination group.
export default function FimsModals() {
  const { t } = useTranslation('fims')
  const { format } = useFimsCurrency()
  const account = useAccountActive()
  const network = useNetworkActive()
  const { member } = useFimsMember(account.publicKey, account)
  const entries = useFimsAddressBook(member?.id, account)
  const { debt, isLoading: debtLoading } = useFimsDebt(member, account)
  const [sendCapSetting] = useSetting('sendCapEur')
  const tokens = useFimsTokens()
  const withdrawalTargets = useWithdrawalTargets()
  const solUsdPrice = useGetTokenMetadataJupiter([NATIVE_MINT]).data?.find((m) => m.id === NATIVE_MINT)?.usdPrice

  const groups = useMemo<UiGroupedComboboxInputGroup<DestinationAccount>[]>(() => {
    const result: UiGroupedComboboxInputGroup<DestinationAccount>[] = entries.data?.length
      ? [
          {
            items: entries.data.map((entry) => ({
              address: entry.address,
              id: `fims-${entry.id}`,
              isSource: false,
              label: entry.label,
            })),
            label: t(($) => $.addressBookTitle),
          },
        ]
      : []
    if (withdrawalTargets.length) {
      result.push({
        items: withdrawalTargets.map((target) => ({
          address: target.address,
          id: `withdrawal-${target.label}`,
          isSource: false,
          label: target.label,
        })),
        label: t(($) => $.withdrawalGroupLabel),
      })
    }
    return result
  }, [entries.data, withdrawalTargets, t])

  // Outgoing send guards. Sends to the treasury always stay open — that is how
  // a debt gets settled on-chain and it is not an "external" withdrawal.
  // 0. Demo guard: the demo account's keys are public — it must never send.
  // 1. Debt guard: outgoing sends are blocked while the member owes FiMs.
  // 2. Send cap: optional EUR limit (Settings → Send limit). The token's EUR
  //    price comes from the FiMs token list; unpriced tokens are not capped —
  //    this is a convenience guard, not a custody policy.
  const isDemo = account.publicKey === FIMS_DEMO_ADDRESS
  const getSendBlock = useMemo(() => {
    const cap = Number.parseFloat(sendCapSetting ?? '')
    const hasCap = Number.isFinite(cap) && cap > 0
    const hasDebt = typeof debt === 'number' && debt > 0
    // While a member's debt position is still loading we cannot prove the send
    // is allowed — fail closed rather than open a bypass window on slow
    // networks. Non-members never trigger this (their queries stay disabled).
    const checkingDebt = Boolean(member) && debtLoading
    if (!isDemo && !hasDebt && !hasCap && !checkingDebt) {
      return undefined
    }
    return (send: SendBlockContext): null | string => {
      if (isDemo) {
        return t(($) => $.demoSendBlocked)
      }
      if (send.destination === FIMS_TREASURY_ADDRESS) {
        return null
      }
      if (checkingDebt) {
        return t(($) => $.debtCheckPending)
      }
      if (hasDebt) {
        return t(($) => $.debtSendBlocked, { amount: format(debt), rate: getFimsTontineRate() * 100 })
      }
      if (hasCap) {
        const price = tokens.data?.find((token) => token.address === send.mint)?.value
        const eur = price ? Number.parseFloat(send.amount) * price : Number.NaN
        if (Number.isFinite(eur) && eur > cap) {
          return t(($) => $.sendCapBlocked, { cap: format(cap), total: format(eur) })
        }
      }
      return null
    }
  }, [debt, debtLoading, isDemo, member, sendCapSetting, tokens.data, t, format])

  // Operating fee on plain sends: getFimsFeeRate() of the sent value, charged
  // in SOL to the treasury. Mainnet only — devnet/localnet sends stay free.
  // Sends to the treasury or the tontine are exempt: a debt settlement or a
  // donation is not a paid operation. Unpriced tokens carry no fee.
  const getSendFee = useMemo(() => {
    if (network.type !== 'solana:mainnet' || !solUsdPrice || solUsdPrice <= 0) {
      return undefined
    }
    return (send: SendFeeContext): SendSolFee | null => {
      if (send.destination === FIMS_TREASURY_ADDRESS || send.destination === FIMS_TONTINE_ADDRESS) {
        return null
      }
      const usdPrice = send.mint.mint === NATIVE_MINT ? solUsdPrice : send.mint.metadata?.usdPrice
      const amount = Number.parseFloat(send.amount)
      if (!usdPrice || usdPrice <= 0 || !Number.isFinite(amount) || amount <= 0) {
        return null
      }
      const lamports = BigInt(Math.ceil((amount * usdPrice * getFimsFeeRate() * SOL_LAMPORTS) / solUsdPrice))
      return lamports > 0n ? { destination: FIMS_TREASURY_ADDRESS as SendSolFee['destination'], lamports } : null
    }
  }, [network.type, solUsdPrice])

  // Sends to a configured off-ramp (exchange / Jupiter Spend) whose outgoing
  // token is not accepted get routed to the auto-conversion confirm screen:
  // a single Jupiter swap delivers an accepted asset straight to the
  // destination's token account.
  const renderSendOverride = (send: SendOverrideContext) => {
    const target = withdrawalTargets.find((item) => item.address === send.destination)
    if (!target || target.acceptedMints.includes(send.mint.mint)) {
      return null
    }
    return (
      <FimsFeatureSendConvert
        account={account}
        amount={send.amount}
        destination={send.destination}
        mint={send.mint}
        network={network}
        target={target}
      />
    )
  }

  return (
    <PortfolioModals
      extraDestinationGroups={groups}
      getSendBlock={getSendBlock}
      getSendFee={getSendFee}
      renderSendOverride={renderSendOverride}
    />
  )
}
