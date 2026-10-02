import type { Address } from '@solana/kit'
import { useQueryClient } from '@tanstack/react-query'
import type { Network } from '@workspace/db/network/network'
import { useAccountsLive } from '@workspace/db-react/use-accounts-live'
import { useNetworkLive } from '@workspace/db-react/use-network-live'
import { useSetting } from '@workspace/db-react/use-setting'
import { useTranslation } from '@workspace/i18n'
import { deriveFromMnemonicAtIndex } from '@workspace/keypair/derive-from-mnemonic-at-index'
import { requestAirdrop } from '@workspace/solana-client/request-airdrop'
import { solToLamports } from '@workspace/solana-client/sol-to-lamports'
import { getBalanceQueryOptions } from '@workspace/solana-client-react/use-get-balance'
import { useSolanaClient } from '@workspace/solana-client-react/use-solana-client'
import { Button } from '@workspace/ui/components/button'
import { UiIcon } from '@workspace/ui/components/ui-icon'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { DEMO_MNEMONIC, demoSetState, demoStop, useDemoState } from './demo-store.tsx'

interface DemoStep {
  description: string
  path: string
  title: string
}

function DemoAirdrop({ address, network }: { address: Address; network: Network }) {
  const client = useSolanaClient({ network })
  const queryClient = useQueryClient()
  const fired = useRef(false)
  useEffect(() => {
    if (fired.current) {
      return
    }
    fired.current = true
    requestAirdrop(client, { address, amount: solToLamports('1') })
      .then(() =>
        queryClient.invalidateQueries({ queryKey: getBalanceQueryOptions({ address, client, network }).queryKey }),
      )
      .catch(() => {})
      .finally(() => demoSetState({ airdropRequested: true }))
  }, [address, client, network, queryClient])
  return null
}

export function DemoTour() {
  const { t } = useTranslation('onboarding')
  const demo = useDemoState()
  const navigate = useNavigate()
  const networks = useNetworkLive()
  const accounts = useAccountsLive()
  const [activeNetworkId, setActiveNetworkId] = useSetting('activeNetworkId')
  const [activeAccountId, setActiveAccountId] = useSetting('activeAccountId')
  const [demoAddress, setDemoAddress] = useState<Address | null>(null)

  const steps = useMemo<DemoStep[]>(
    () => [
      {
        description: t(($) => $.demoStepImportDescription),
        path: '/onboarding/import',
        title: t(($) => $.demoStepImportTitle),
      },
      {
        description: t(($) => $.demoStepPortfolioDescription),
        path: '/portfolio',
        title: t(($) => $.demoStepPortfolioTitle),
      },
      { description: t(($) => $.demoStepFimsDescription), path: '/fims', title: t(($) => $.demoStepFimsTitle) },
      {
        description: t(($) => $.demoStepCommunityDescription),
        path: '/fims/community',
        title: t(($) => $.demoStepCommunityTitle),
      },
      {
        description: t(($) => $.demoStepTontineDescription),
        path: '/fims/tontine',
        title: t(($) => $.demoStepTontineTitle),
      },
      { description: t(($) => $.demoStepLearnDescription), path: '/fims/learn', title: t(($) => $.demoStepLearnTitle) },
      {
        description: t(($) => $.demoStepExplorerDescription),
        path: '/explorer',
        title: t(($) => $.demoStepExplorerTitle),
      },
      { description: t(($) => $.demoStepToolsDescription), path: '/tools', title: t(($) => $.demoStepToolsTitle) },
      {
        description: t(($) => $.demoStepSettingsDescription),
        path: '/settings',
        title: t(($) => $.demoStepSettingsTitle),
      },
    ],
    [t],
  )

  const step = steps[demo.stepIndex]
  const isLastStep = demo.stepIndex === steps.length - 1

  useEffect(() => {
    if (demo.active && step) {
      navigate(step.path)
    }
  }, [demo.active, step, navigate])

  useEffect(() => {
    if (!demo.active || demoAddress) {
      return
    }
    deriveFromMnemonicAtIndex({ mnemonic: DEMO_MNEMONIC })
      .then(({ publicKey }) => setDemoAddress(publicKey))
      .catch(() => {})
  }, [demo.active, demoAddress])

  useEffect(() => {
    if (!demo.active || !demo.walletCreated || !demoAddress) {
      return
    }
    const demoAccount = accounts.find((account) => account.publicKey === demoAddress)
    if (demoAccount && activeAccountId !== demoAccount.id) {
      setActiveAccountId(demoAccount.id).catch(() => {})
    }
  }, [demo.active, demo.walletCreated, demoAddress, accounts, activeAccountId, setActiveAccountId])

  async function handleQuit() {
    const { previousAccountId, previousNetworkId } = demo
    demoStop()
    if (previousAccountId && previousAccountId !== activeAccountId) {
      await setActiveAccountId(previousAccountId).catch(() => {})
    }
    if (previousNetworkId && previousNetworkId !== activeNetworkId) {
      await setActiveNetworkId(previousNetworkId).catch(() => {})
    }
  }

  if (!demo.active || !step) {
    return null
  }

  const devnet = networks.find((network) => network.type === 'solana:devnet')
  const showAirdrop = demo.walletCreated && !demo.airdropRequested && demoAddress && devnet

  return (
    <>
      {showAirdrop ? <DemoAirdrop address={demoAddress} network={devnet} /> : null}
      <div className="pointer-events-none fixed inset-x-0 bottom-16 z-50 flex justify-center px-3 md:bottom-20">
        <div className="pointer-events-auto w-full max-w-md rounded-xl border border-primary/40 bg-card/95 p-4 shadow-[0_0_40px_-5px] shadow-primary/40 backdrop-blur-md">
          <div className="mb-2 flex items-center justify-between">
            <span className="rounded-full bg-primary/15 px-2.5 py-0.5 font-semibold text-primary text-xs uppercase tracking-wide">
              {t(($) => $.demoStepCounter, { current: demo.stepIndex + 1, total: steps.length })}
            </span>
            <button
              aria-label={t(($) => $.demoExit)}
              className="text-muted-foreground transition-colors hover:text-foreground"
              onClick={handleQuit}
              type="button"
            >
              <UiIcon className="size-4" icon="x" />
            </button>
          </div>
          <div className="mb-3 h-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-gradient-to-r from-[#9945ff] to-[#14f195] transition-all duration-500"
              style={{ width: `${((demo.stepIndex + 1) / steps.length) * 100}%` }}
            />
          </div>
          <h3 className="font-semibold">{step.title}</h3>
          <p className="mt-1 text-muted-foreground text-sm">{step.description}</p>
          <div className="mt-4 flex items-center justify-between">
            <Button onClick={handleQuit} variant="ghost">
              {t(($) => $.demoExit)}
            </Button>
            <div className="flex gap-2">
              <Button
                disabled={demo.stepIndex === 0}
                onClick={() => demoSetState({ stepIndex: demo.stepIndex - 1 })}
                variant="outline"
              >
                {t(($) => $.demoPrev)}
              </Button>
              <Button
                onClick={() => {
                  if (isLastStep) {
                    void handleQuit()
                  } else {
                    demoSetState({ stepIndex: demo.stepIndex + 1 })
                  }
                }}
              >
                {isLastStep ? t(($) => $.demoFinish) : t(($) => $.demoNext)}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
