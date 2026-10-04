import { useTranslation } from '@workspace/i18n'
import { UiCard } from '@workspace/ui/components/ui-card'
import { UiIcon } from '@workspace/ui/components/ui-icon'
import type { UiIconName } from '@workspace/ui/components/ui-icon-map'
import { getFimsFeeRate, getFimsTontineRate } from './fims-fee-config.ts'

type LearnEntry = { body: string; href?: string; term: string }
type LearnSection = { description: string; entries: LearnEntry[]; icon: UiIconName; title: string }

// Educational page: explains the figures shown in the app, the crypto basics
// and the risks. Purely informational — no wallet data involved.
export function FimsFeatureLearn() {
  const { t } = useTranslation('fims')

  const sections: LearnSection[] = [
    {
      description: t(($) => $.learnFiguresDesc),
      entries: [
        { body: t(($) => $.learnInvestedBody), term: t(($) => $.learnInvestedTerm) },
        { body: t(($) => $.learnCurrentValueBody), term: t(($) => $.learnCurrentValueTerm) },
        { body: t(($) => $.learnPnlBody), term: t(($) => $.learnPnlTerm) },
        { body: t(($) => $.learnRatiosBody), term: t(($) => $.learnRatiosTerm) },
        {
          body: t(($) => $.learnDonationsBody, { rate: getFimsTontineRate() * 100 }),
          term: t(($) => $.learnDonationsTerm),
        },
        { body: t(($) => $.learnTontineBody), term: t(($) => $.learnTontineTerm) },
        { body: t(($) => $.learnTreasuryBody), term: t(($) => $.learnTreasuryTerm) },
      ],
      icon: 'portfolio',
      title: t(($) => $.learnFiguresTitle),
    },
    {
      description: t(($) => $.learnCryptoDesc),
      entries: [
        { body: t(($) => $.learnSolanaBody), term: t(($) => $.learnSolanaTerm) },
        { body: t(($) => $.learnTokensBody), term: t(($) => $.learnTokensTerm) },
        { body: t(($) => $.learnSwapBody), term: t(($) => $.learnSwapTerm) },
        { body: t(($) => $.learnLimitBody), term: t(($) => $.learnLimitTerm) },
        { body: t(($) => $.learnVolatilityBody), term: t(($) => $.learnVolatilityTerm) },
        { body: t(($) => $.learnFeesBody, { fee: getFimsFeeRate() * 100 }), term: t(($) => $.learnFeesTerm) },
      ],
      icon: 'coins',
      title: t(($) => $.learnCryptoTitle),
    },
    {
      description: t(($) => $.learnRisksDesc),
      entries: [
        { body: t(($) => $.learnNotAdviceBody), term: t(($) => $.learnNotAdviceTerm) },
        { body: t(($) => $.learnSeedBody), term: t(($) => $.learnSeedTerm) },
        { body: t(($) => $.learnAddressesBody), term: t(($) => $.learnAddressesTerm) },
        { body: t(($) => $.learnDyorBody), term: t(($) => $.learnDyorTerm) },
        { body: t(($) => $.learnScamBody), term: t(($) => $.learnScamTerm) },
      ],
      icon: 'alert',
      title: t(($) => $.learnRisksTitle),
    },
    {
      description: t(($) => $.learnMethodsDesc),
      entries: [
        { body: t(($) => $.learnDcaBody), term: t(($) => $.learnDcaTerm) },
        { body: t(($) => $.learnStablecoinsBody), term: t(($) => $.learnStablecoinsTerm) },
        { body: t(($) => $.learnDiversifyBody), term: t(($) => $.learnDiversifyTerm) },
        { body: t(($) => $.learnYieldRiskBody), term: t(($) => $.learnYieldRiskTerm) },
        { body: t(($) => $.learnYieldCurrentBody), term: t(($) => $.learnYieldCurrentTerm) },
      ],
      icon: 'handCoins',
      title: t(($) => $.learnMethodsTitle),
    },
    {
      description: t(($) => $.learnServicesDesc),
      entries: [
        {
          body: t(($) => $.learnMultisigBody),
          href: 'https://squads.xyz',
          term: t(($) => $.learnMultisigTerm),
        },
        {
          body: t(($) => $.learnCoinbaseBody),
          href: 'https://coinbase.com/join/TVFNWB5?src=android-link',
          term: t(($) => $.learnCoinbaseTerm),
        },
        {
          body: t(($) => $.learnNexoBody),
          href: 'https://nexo.com',
          term: t(($) => $.learnNexoTerm),
        },
        {
          body: t(($) => $.learnBitpandaBody),
          href: 'https://www.bitpanda.com',
          term: t(($) => $.learnBitpandaTerm),
        },
        {
          body: t(($) => $.learnJupiterBody),
          href: 'https://jupiter.go.link/fAUD1',
          term: t(($) => $.learnJupiterTerm),
        },
      ],
      icon: 'tools',
      title: t(($) => $.learnServicesTitle),
    },
  ]

  return (
    <div className="space-y-4">
      {sections.map((section) => (
        <UiCard
          description={section.description}
          key={section.title}
          title={
            <span className="flex items-center gap-2">
              <UiIcon className="h-4 w-4" icon={section.icon} />
              {section.title}
            </span>
          }
        >
          <dl className="space-y-3">
            {section.entries.map((entry) => (
              <div key={entry.term}>
                <dt className="font-medium text-sm">
                  {entry.href ? (
                    <a className="text-primary underline" href={entry.href} rel="noreferrer" target="_blank">
                      {entry.term}
                    </a>
                  ) : (
                    entry.term
                  )}
                </dt>
                <dd className="text-muted-foreground text-sm">{entry.body}</dd>
              </div>
            ))}
          </dl>
        </UiCard>
      ))}
    </div>
  )
}
