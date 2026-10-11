import { solanaAddressSchema } from '@workspace/db/solana/solana-address-schema'
import { useSetting } from '@workspace/db-react/use-setting'
import { useWithdrawalDestinations } from '@workspace/feature-fims/data-access/use-withdrawal-destinations'
import {
  FIMS_COINBASE_REFERRAL_URL,
  FIMS_JUPITER_SPEND_REFERRAL_CODE,
  FIMS_JUPITER_SPEND_REFERRAL_URL,
  FIMS_NEXO_REFERRAL_URL,
  FIMS_WITHDRAWAL_PROVIDER_COLORS,
  FIMS_WITHDRAWAL_PROVIDER_LABELS,
  type FimsWithdrawalDestination,
  type FimsWithdrawalProviderId,
} from '@workspace/feature-fims/fims-constants'
import { useTranslation } from '@workspace/i18n'
import { Button } from '@workspace/ui/components/button'
import { Input } from '@workspace/ui/components/input'
import { Label } from '@workspace/ui/components/label'
import { UiIcon } from '@workspace/ui/components/ui-icon'
import { UiTextCopyButton } from '@workspace/ui/components/ui-text-copy-button'
import { UiTextCopyIcon } from '@workspace/ui/components/ui-text-copy-icon'
import { UiTooltip } from '@workspace/ui/components/ui-tooltip'
import { ellipsify } from '@workspace/ui/lib/ellipsify'
import { useEffect, useId, useState } from 'react'
import { SettingsUiWithdrawalCompare } from './ui/settings-ui-withdrawal-compare.tsx'

const PROVIDER_CHOICES: Exclude<FimsWithdrawalProviderId, 'other'>[] = ['jupiter', 'coinbase', 'nexo']

const REFERRAL_URLS: Record<Exclude<FimsWithdrawalProviderId, 'other'>, string> = {
  coinbase: FIMS_COINBASE_REFERRAL_URL,
  jupiter: FIMS_JUPITER_SPEND_REFERRAL_URL,
  nexo: FIMS_NEXO_REFERRAL_URL,
}

function providerName(provider: FimsWithdrawalProviderId): string {
  return provider === 'other' ? '' : FIMS_WITHDRAWAL_PROVIDER_LABELS[provider]
}

const PROVIDER_LOGO_SRC: Record<Exclude<FimsWithdrawalProviderId, 'other'>, string> = {
  coinbase: '/exchanges/coinbase.svg',
  jupiter: '/exchanges/jupiter.svg',
  nexo: '/exchanges/nexo.svg',
}

// Brand logos are bundled assets — loading them remotely would leak the
// user's off-ramps through image requests. Custom providers get a letter
// circle instead.
function ProviderLogo({ name, provider }: { name: string; provider: FimsWithdrawalProviderId }) {
  if (provider !== 'other') {
    return <img alt="" className="size-8 shrink-0" src={PROVIDER_LOGO_SRC[provider]} />
  }
  return (
    <span
      aria-hidden
      className="flex size-8 shrink-0 items-center justify-center rounded-full font-semibold text-white text-xs"
      style={{ backgroundColor: FIMS_WITHDRAWAL_PROVIDER_COLORS[provider] }}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  )
}

// Off-ramp addresses the user withdraws to regularly. Saved destinations are
// offered in the send picker; sends of an asset the service does not accept
// are routed through an automatic swap into an accepted one.
export function SettingsFeatureGeneralWithdrawal() {
  const { t } = useTranslation('settings')
  const { destinations, remove, save, upsert } = useWithdrawalDestinations()
  const [provider, setExchangeProvider] = useSetting('withdrawExchangeProvider')
  const [exchangeAddress, setExchangeAddress] = useSetting('withdrawExchangeAddress')
  const [spendAddress, setSpendAddress] = useSetting('withdrawJupiterSpend')
  const [editing, setEditing] = useState<FimsWithdrawalDestination | 'new' | 'signup' | null>(null)
  const [showCompare, setShowCompare] = useState(false)

  // One-time migration of the legacy single-address settings into the list.
  useEffect(() => {
    if (destinations.length || (!exchangeAddress && !spendAddress)) {
      return
    }
    const legacy: FimsWithdrawalDestination[] = []
    if (exchangeAddress) {
      const legacyProvider = provider === 'nexo' ? 'nexo' : 'coinbase'
      legacy.push({
        address: exchangeAddress,
        id: crypto.randomUUID(),
        name: FIMS_WITHDRAWAL_PROVIDER_LABELS[legacyProvider],
        provider: legacyProvider,
      })
    }
    if (spendAddress) {
      legacy.push({
        address: spendAddress,
        id: crypto.randomUUID(),
        name: 'Jupiter Spend',
        provider: 'jupiter',
      })
    }
    void save(legacy)
    void setExchangeAddress('')
    void setExchangeProvider('')
    void setSpendAddress('')
  }, [
    destinations.length,
    exchangeAddress,
    provider,
    save,
    spendAddress,
    setExchangeAddress,
    setExchangeProvider,
    setSpendAddress,
  ])

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1">
        <Label>{t(($) => $.pageGeneralWithdrawal)}</Label>
        <UiTooltip>{t(($) => $.pageGeneralWithdrawalHint)}</UiTooltip>
      </div>

      {editing === null ? (
        <div className="space-y-3">
          {destinations.map((destination) => (
            <div className="flex items-center gap-3" key={destination.id}>
              <ProviderLogo name={destination.name} provider={destination.provider} />
              <div className="min-w-0 flex-1">
                <div className="font-medium text-sm">{destination.name}</div>
                <div className="truncate font-mono text-muted-foreground text-xs">
                  {ellipsify(destination.address, 6)}
                </div>
              </div>
              <UiTextCopyIcon text={destination.address} toast={t(($) => $.pageGeneralWithdrawalCopied)} />
              <Button onClick={() => setEditing(destination)} size="icon" variant="ghost">
                <UiIcon icon="edit" />
              </Button>
              <Button onClick={() => void remove(destination.id)} size="icon" variant="ghost">
                <UiIcon icon="delete" />
              </Button>
            </div>
          ))}

          {destinations.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t(($) => $.pageGeneralWithdrawalEmpty)}</p>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setEditing('new')} variant="outline">
              <UiIcon icon="add" /> {t(($) => $.pageGeneralWithdrawalAdd)}
            </Button>
            <Button onClick={() => setEditing('signup')} variant="outline">
              {t(($) => $.pageGeneralWithdrawalCreate)}
            </Button>
            <Button onClick={() => setShowCompare((show) => !show)} variant="ghost">
              {t(($) => $.pageGeneralWithdrawalCompareToggle)}
            </Button>
          </div>

          {showCompare ? <SettingsUiWithdrawalCompare /> : null}
        </div>
      ) : editing === 'signup' ? (
        <SignupPicker onDone={() => setEditing(null)} />
      ) : (
        <WithdrawalForm
          destination={editing === 'new' ? null : editing}
          onDone={() => setEditing(null)}
          upsert={upsert}
        />
      )}
    </div>
  )
}

// "Open an account" step: the three known off-ramps, each with the referral
// link first then the full sign-up walkthrough (KYC included).
// Guides are resolved with static key references — i18next-cli extract drops
// keys only reached through dynamic lookups.
function SignupPicker({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation('settings')
  const guides: Record<Exclude<FimsWithdrawalProviderId, 'other'>, string> = {
    coinbase: t(($) => $.pageGeneralWithdrawalGuideCoinbase),
    jupiter: t(($) => $.pageGeneralWithdrawalGuideJupiter),
    nexo: t(($) => $.pageGeneralWithdrawalGuideNexo),
  }
  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">{t(($) => $.pageGeneralWithdrawalCreateHint)}</p>
      {PROVIDER_CHOICES.map((choice) => {
        const label = providerName(choice)
        return (
          <div className="rounded-lg border px-4 py-3" key={choice}>
            <div className="flex items-center gap-3">
              <ProviderLogo name={label} provider={choice} />
              <span className="flex-1 font-medium text-sm">{label}</span>
              <a
                className="text-primary text-sm underline"
                href={REFERRAL_URLS[choice]}
                rel="noreferrer"
                target="_blank"
              >
                {t(($) => $.pageGeneralWithdrawalSignup, { provider: label })}
              </a>
            </div>
            <p className="mt-2 whitespace-pre-line text-muted-foreground text-sm">{guides[choice]}</p>
            {choice === 'jupiter' ? (
              <div className="mt-2 flex items-center gap-2">
                <UiTextCopyButton
                  label={FIMS_JUPITER_SPEND_REFERRAL_CODE}
                  size="sm"
                  text={FIMS_JUPITER_SPEND_REFERRAL_CODE}
                  toast={t(($) => $.pageGeneralWithdrawalSpendReferralCopied)}
                />
              </div>
            ) : null}
          </div>
        )
      })}
      <div className="flex justify-end">
        <Button onClick={onDone} variant="ghost">
          {t(($) => $.actionBack)}
        </Button>
      </div>
    </div>
  )
}

// Step-by-step form: pick a provider first (with the referral links for the
// known off-ramps), then enter the deposit address — custom providers also ask
// for a display name.
function WithdrawalForm({
  destination,
  onDone,
  upsert,
}: {
  destination: FimsWithdrawalDestination | null
  onDone: () => void
  upsert: (item: FimsWithdrawalDestination) => Promise<void>
}) {
  const { t } = useTranslation('settings')
  const nameId = useId()
  const addressId = useId()
  const [provider, setProvider] = useState<FimsWithdrawalProviderId | null>(destination?.provider ?? null)
  const [name, setName] = useState(destination?.name ?? '')
  const [address, setAddress] = useState(destination?.address ?? '')
  const [busy, setBusy] = useState(false)

  const isNew = destination === null
  const addressTrimmed = address.trim()
  const addressInvalid = addressTrimmed.length > 0 && !solanaAddressSchema.safeParse(addressTrimmed).success
  const needsName = provider === 'other'
  const nameTrimmed = name.trim()
  const canSave = !addressInvalid && addressTrimmed.length > 0 && (!needsName || nameTrimmed.length > 0)

  async function handleSave() {
    if (!provider || !canSave) {
      return
    }
    setBusy(true)
    try {
      await upsert({
        address: addressTrimmed,
        id: destination?.id ?? crypto.randomUUID(),
        name: needsName ? nameTrimmed : providerName(provider),
        provider,
      })
      onDone()
    } finally {
      setBusy(false)
    }
  }

  // Step 1 (new destinations only): provider picker.
  if (provider === null) {
    return (
      <div className="space-y-2">
        <p className="text-muted-foreground text-sm">{t(($) => $.pageGeneralWithdrawalPickProvider)}</p>
        {[...PROVIDER_CHOICES, 'other' as const].map((choice) => {
          const label = choice === 'other' ? t(($) => $.pageGeneralWithdrawalOther) : providerName(choice)
          return (
            <button
              className="flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left hover:bg-accent"
              key={choice}
              onClick={() => setProvider(choice)}
              type="button"
            >
              <ProviderLogo name={label} provider={choice} />
              <span className="flex-1">
                <span className="block font-medium text-sm">{label}</span>
                {choice !== 'other' ? (
                  <a
                    className="text-primary text-xs underline"
                    href={REFERRAL_URLS[choice]}
                    onClick={(event) => event.stopPropagation()}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {t(($) => $.pageGeneralWithdrawalSignup, { provider: label })}
                  </a>
                ) : null}
              </span>
              <UiIcon icon="chevronRight" />
            </button>
          )
        })}
        <div className="flex justify-end">
          <Button onClick={onDone} variant="ghost">
            {t(($) => $.actionCancel)}
          </Button>
        </div>
      </div>
    )
  }

  // Step 2: name (custom providers) + deposit address.
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <ProviderLogo
          name={needsName ? nameTrimmed || t(($) => $.pageGeneralWithdrawalOther) : providerName(provider)}
          provider={provider}
        />
        <div className="font-medium text-sm">
          {needsName ? t(($) => $.pageGeneralWithdrawalOther) : providerName(provider)}
        </div>
        {isNew ? (
          <Button onClick={() => setProvider(null)} size="sm" variant="ghost">
            {t(($) => $.actionBack)}
          </Button>
        ) : null}
      </div>

      {needsName ? (
        <div className="space-y-2">
          <Label htmlFor={nameId}>{t(($) => $.pageGeneralWithdrawalName)}</Label>
          <Input
            id={nameId}
            onChange={(event) => setName(event.target.value)}
            placeholder={t(($) => $.pageGeneralWithdrawalNamePlaceholder)}
            value={name}
          />
        </div>
      ) : null}

      <div className="space-y-2">
        <Label htmlFor={addressId}>{t(($) => $.pageGeneralWithdrawalAddress)}</Label>
        <Input
          className={addressInvalid ? 'border-destructive' : undefined}
          id={addressId}
          onChange={(event) => setAddress(event.target.value)}
          placeholder={t(($) => $.pageGeneralWithdrawalAddressPlaceholder)}
          spellCheck={false}
          value={address}
        />
        {addressInvalid ? <p className="text-destructive text-sm">{t(($) => $.pageGeneralWithdrawalInvalid)}</p> : null}
      </div>

      {provider === 'jupiter' ? (
        <p className="text-muted-foreground text-xs">
          {t(($) => $.pageGeneralWithdrawalSpendReferralHint)} {FIMS_JUPITER_SPEND_REFERRAL_CODE}
        </p>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button onClick={onDone} variant="ghost">
          {t(($) => $.actionCancel)}
        </Button>
        <Button disabled={!canSave || busy} onClick={() => void handleSave()}>
          {t(($) => $.actionSave)}
        </Button>
      </div>
    </div>
  )
}
