import type { Address } from '@solana/kit'
import type { Network } from '@workspace/db/network/network'
import { solanaAddressSchema } from '@workspace/db/solana/solana-address-schema'
import { useSetting } from '@workspace/db-react/use-setting'
import { usePortfolioTokenMint } from '@workspace/feature-portfolio/data-access/use-portfolio-token-mint'
import { PortfolioUiModal } from '@workspace/feature-portfolio/ui/portfolio-ui-modal'
import {
  type DestinationAccount,
  PortfolioUiSendDestination,
} from '@workspace/feature-portfolio/ui/portfolio-ui-send-destination'
import { useTranslation } from '@workspace/i18n'
import { getUnsafeSendDestinationType } from '@workspace/solana-client/is-unsafe-send-destination'
import { useSolanaClient } from '@workspace/solana-client-react/use-solana-client'
import { Button } from '@workspace/ui/components/button'
import { Input } from '@workspace/ui/components/input'
import { UiError } from '@workspace/ui/components/ui-error'
import type { UiGroupedComboboxInputGroup } from '@workspace/ui/components/ui-grouped-combobox-input'
import { UiIcon } from '@workspace/ui/components/ui-icon'
import { cn } from '@workspace/ui/lib/utils'
import { useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router'
import {
  FIMS_COINBASE_REFERRAL_URL,
  FIMS_JUPITER_SPEND_REFERRAL_CODE,
  FIMS_JUPITER_SPEND_REFERRAL_URL,
  FIMS_JUPITER_SPEND_SYMBOLS,
  FIMS_NEXO_REFERRAL_URL,
  FIMS_WITHDRAWAL_PROVIDERS,
} from './fims-constants.ts'

// Guided destination step for member sends. Withdrawing to an exchange is the
// classic footgun (a mint address pasted instead of a deposit address burns
// the funds), so the picker steers members through the known providers:
// referral link, how-to steps, a screenshot slot, then the member's own
// deposit address — validated on-chain before the send continues.
// "Other" falls back to the free-form picker (address book, whitelist…).
// Nexo is deliberately LAST in the order.
type ExchangeId = 'coinbase' | 'jupiter' | 'nexo'

interface ExchangeOption {
  acceptedSymbols: readonly string[]
  // Screenshot slot — drop the file in public/guides/<id>.png and it shows.
  guideImage?: string | undefined
  id: ExchangeId
  referralCode?: string | undefined
  referralUrl: string
}

const EXCHANGE_OPTIONS: ExchangeOption[] = [
  {
    acceptedSymbols: FIMS_WITHDRAWAL_PROVIDERS.coinbase.acceptedSymbols,
    id: 'coinbase',
    referralUrl: FIMS_COINBASE_REFERRAL_URL,
  },
  {
    acceptedSymbols: FIMS_JUPITER_SPEND_SYMBOLS,
    id: 'jupiter',
    referralCode: FIMS_JUPITER_SPEND_REFERRAL_CODE,
    referralUrl: FIMS_JUPITER_SPEND_REFERRAL_URL,
  },
  {
    acceptedSymbols: FIMS_WITHDRAWAL_PROVIDERS.nexo.acceptedSymbols,
    id: 'nexo',
    referralUrl: FIMS_NEXO_REFERRAL_URL,
  },
]

export function FimsFeatureSendDestination({
  address: sourceAddress,
  extraGroups,
  network,
}: {
  address: Address
  extraGroups?: UiGroupedComboboxInputGroup<DestinationAccount>[] | undefined
  network: Network
}) {
  const { t } = useTranslation('fims')
  const { token } = useParams<{ token: string }>()
  const location = useLocation()
  const navigate = useNavigate()
  const mint = usePortfolioTokenMint({ address: sourceAddress, network, token })
  const [expanded, setExpanded] = useState<ExchangeId | 'other' | null>(null)

  if (!token || !mint) {
    return (
      <PortfolioUiModal title={t(($) => $.sendDestTitle)}>
        <UiError message={new Error(`Token not found: ${token}`)} title="Token not found" />
      </PortfolioUiModal>
    )
  }

  return (
    <PortfolioUiModal title={t(($) => $.sendDestTitle)}>
      <div className="space-y-2">
        {EXCHANGE_OPTIONS.map((option) => (
          <div className="rounded-lg border" key={option.id}>
            <button
              className="flex w-full items-center justify-between px-4 py-3 text-left"
              onClick={() => setExpanded(expanded === option.id ? null : option.id)}
              type="button"
            >
              <span className="font-medium">
                {option.id === 'coinbase' ? 'Coinbase' : option.id === 'jupiter' ? 'Jupiter Spend' : 'Nexo'}
              </span>
              <UiIcon
                className={cn('size-4 transition-transform', expanded === option.id && 'rotate-90')}
                icon="chevronRight"
              />
            </button>
            {expanded === option.id ? (
              <ExchangeGuide
                network={network}
                onSubmit={async (destination) => {
                  await navigate(`/modals/send/${token}/${destination}`, { state: { from: location.pathname } })
                }}
                option={option}
              />
            ) : null}
          </div>
        ))}

        <div className="rounded-lg border">
          <button
            className="flex w-full items-center justify-between px-4 py-3 text-left"
            onClick={() => setExpanded(expanded === 'other' ? null : 'other')}
            type="button"
          >
            <span className="font-medium">{t(($) => $.sendDestOtherLabel)}</span>
            <UiIcon
              className={cn('size-4 transition-transform', expanded === 'other' && 'rotate-90')}
              icon="chevronRight"
            />
          </button>
          {expanded === 'other' ? (
            <div className="border-t px-4 pt-4 pb-2">
              <PortfolioUiSendDestination
                extraGroups={extraGroups}
                isLoading={false}
                mint={mint}
                network={network}
                sourceAddress={sourceAddress}
                submit={async (input) =>
                  await navigate(`/modals/send/${token}/${input.destination}`, {
                    state: { from: location.pathname },
                  })
                }
              />
            </div>
          ) : null}
        </div>
      </div>
    </PortfolioUiModal>
  )
}

function ExchangeGuide({
  network,
  onSubmit,
  option,
}: {
  network: Network
  onSubmit: (destination: string) => Promise<void>
  option: ExchangeOption
}) {
  const { t } = useTranslation('fims')
  const client = useSolanaClient({ network })
  const [, setExchangeProvider] = useSetting('withdrawExchangeProvider')
  const [, setExchangeAddress] = useSetting('withdrawExchangeAddress')
  const [, setSpendAddress] = useSetting('withdrawJupiterSpend')
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)

  const providerLabel = option.id === 'coinbase' ? 'Coinbase' : option.id === 'jupiter' ? 'Jupiter Spend' : 'Nexo'

  const trimmed = value.trim()
  const syntaxOk = trimmed.length === 0 || solanaAddressSchema.safeParse(trimmed).success

  async function handleContinue() {
    if (!syntaxOk || !trimmed) return
    setChecking(true)
    setError(null)
    try {
      const unsafe = await getUnsafeSendDestinationType(client, trimmed as Address)
      if (unsafe) {
        setError(t(($) => $.sendDestNotWallet))
        return
      }
      // Remember the configured off-ramp so the destination stays listed and
      // the auto-convert path knows which mints the service accepts.
      if (option.id === 'jupiter') {
        await setSpendAddress(trimmed)
      } else {
        await setExchangeProvider(option.id)
        await setExchangeAddress(trimmed)
      }
      await onSubmit(trimmed)
    } catch {
      setError(t(($) => $.sendDestCheckFailed))
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="space-y-3 border-t px-4 pt-3 pb-4 text-sm">
      <p className="whitespace-pre-line text-muted-foreground">
        {option.id === 'coinbase'
          ? t(($) => $.sendDestGuideCoinbase)
          : option.id === 'jupiter'
            ? t(($) => $.sendDestGuideJupiter)
            : t(($) => $.sendDestGuideNexo)}
      </p>
      <a
        className="inline-flex items-center gap-1 text-primary underline"
        href={option.referralUrl}
        rel="noreferrer"
        target="_blank"
      >
        {t(($) => $.sendDestReferral, { provider: providerLabel })}
        <UiIcon className="size-3.5" icon="externalLink" />
      </a>
      {option.referralCode ? (
        <p className="text-muted-foreground">{t(($) => $.sendDestReferralCode, { code: option.referralCode })}</p>
      ) : null}
      {option.guideImage ? (
        <img alt={providerLabel} className="w-full rounded-md border" src={option.guideImage} />
      ) : (
        <div className="flex aspect-[16/9] w-full items-center justify-center rounded-md border border-dashed text-muted-foreground text-xs">
          {t(($) => $.sendDestScreenshotPending)}
        </div>
      )}
      <p className="text-muted-foreground text-xs">
        {t(($) => $.sendDestAcceptedNote, { accepted: option.acceptedSymbols.join(', ') })}
      </p>
      <Input
        className={syntaxOk && !error ? undefined : 'border-destructive'}
        onChange={(event) => {
          setValue(event.target.value)
          setError(null)
        }}
        placeholder={t(($) => $.sendDestAddressLabel, { provider: providerLabel })}
        spellCheck={false}
        value={value}
      />
      {error || !syntaxOk ? (
        <p className="text-destructive text-sm">{error ?? t(($) => $.sendDestInvalidAddress)}</p>
      ) : null}
      <Button className="w-full" disabled={!trimmed || !syntaxOk || checking} onClick={handleContinue}>
        {t(($) => $.sendDestContinue)}
      </Button>
    </div>
  )
}
