import type { Address } from '@solana/kit'
import { useQueryClient } from '@tanstack/react-query'
import { useAppContext } from '@workspace/context-react/use-app-context'
import type { Account } from '@workspace/db/account/account'
import type { Network } from '@workspace/db/network/network'
import { useAccountSecretKey } from '@workspace/db-react/use-account-secret-key'
import { useAccountsLive } from '@workspace/db-react/use-accounts-live'
import { useNetworkLive } from '@workspace/db-react/use-network-live'
import { useSetting } from '@workspace/db-react/use-setting'
import { env } from '@workspace/env/env'
import { fimsSignedFetch } from '@workspace/feature-fims/fims-api'
import { useTranslation } from '@workspace/i18n'
import { createKeyPairSignerFromJson } from '@workspace/keypair/create-key-pair-signer-from-json'
import { deriveFromMnemonicAtIndex } from '@workspace/keypair/derive-from-mnemonic-at-index'
import { requestAirdrop } from '@workspace/solana-client/request-airdrop'
import { solToLamports } from '@workspace/solana-client/sol-to-lamports'
import { getBalanceQueryOptions } from '@workspace/solana-client-react/use-get-balance'
import { useSolanaClient } from '@workspace/solana-client-react/use-solana-client'
import { Button } from '@workspace/ui/components/button'
import { UiIcon } from '@workspace/ui/components/ui-icon'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { demoCleanupStale, demoCleanupWallet } from './demo-cleanup.ts'
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

// The demo wallet self-registers as a community member so member-scoped
// pages (profile, votes, address book) work during the tour. Members can
// register themselves (owner-signed POST /users); a conflict means the row
// already exists — either way the demo account ends up a member.
function DemoMemberRegistration({ account }: { account: Account }) {
  const accountSecretKey = useAccountSecretKey()
  const queryClient = useQueryClient()
  const fired = useRef(false)
  useEffect(() => {
    if (fired.current) {
      return
    }
    fired.current = true
    ;(async () => {
      const json = await accountSecretKey({ account })
      const signer = await createKeyPairSignerFromJson({ json })
      await fimsSignedFetch(env('apiEndpoint'), signer, 'POST', '/users', {
        address: signer.address,
        isPublic: true,
        name: 'Démo',
      })
    })()
      .then(() => queryClient.invalidateQueries({ queryKey: ['fims', 'users'] }))
      .catch(() => {})
      .finally(() => demoSetState({ memberRegistered: true }))
  }, [account, accountSecretKey, queryClient])
  return null
}

export function DemoTour() {
  const { t } = useTranslation('onboarding')
  const context = useAppContext()
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
      {
        description: t(($) => $.demoStepVotesDescription),
        path: '/fims/votes',
        title: t(($) => $.demoStepVotesTitle),
      },
      { description: t(($) => $.demoStepLearnDescription), path: '/fims/learn', title: t(($) => $.demoStepLearnTitle) },
      {
        description: t(($) => $.demoStepExplorerDescription),
        path: '/explorer',
        title: t(($) => $.demoStepExplorerTitle),
      },
      // No /tools step: that section is admin-only and the tour is a
      // newcomer's walkthrough — the demo account is never an admin.
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
      .then(async ({ publicKey }) => {
        setDemoAddress(publicKey)
        // Drop 'Démo' wallets left behind by interrupted earlier runs — the
        // public-mnemonic wallet must never linger in the user's list.
        await demoCleanupStale(context, publicKey, demo.walletId).catch(() => {})
      })
      .catch(() => {})
  }, [demo.active, demoAddress, demo.walletId, context])

  // Fires once per demo wallet: the mutation setter identity changes every
  // render, and without a guard each mutation re-render re-fires it — a flood
  // of settings transactions that jams the whole write queue (the quit-time
  // cleanup then never lands, and flood writes keep re-pointing
  // activeAccountId at the demo account).
  const activatedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!demo.active || !demo.walletCreated || !demo.walletId) {
      activatedRef.current = null
      return
    }
    const demoAccount = accounts.find((account) => account.walletId === demo.walletId)
    if (demoAccount && activeAccountId !== demoAccount.id && activatedRef.current !== demoAccount.id) {
      activatedRef.current = demoAccount.id
      setActiveAccountId(demoAccount.id).catch(() => {})
    }
  }, [demo.active, demo.walletCreated, demo.walletId, accounts, activeAccountId, setActiveAccountId])

  async function handleQuit() {
    const { previousAccountId, previousNetworkId, walletId } = demo
    demoStop()
    // Restore BEFORE cleanup: the cleanup's dangling-pointer check would
    // otherwise see the demo account id still stored, delete the settings
    // row, and the restore's get-then-update would land on a deleted row —
    // a silent no-op leaving no active account at all.
    if (previousAccountId && previousAccountId !== activeAccountId) {
      await setActiveAccountId(previousAccountId).catch(() => {})
    }
    if (previousNetworkId && previousNetworkId !== activeNetworkId) {
      await setActiveNetworkId(previousNetworkId).catch(() => {})
    }
    // The demo keys are public knowledge — never leave an unsecured wallet
    // holding them behind: anything that lands on that address is public
    // property for bots and curious readers.
    if (walletId) {
      await demoCleanupWallet(context, walletId)
    }
    // Leaving the tour can strand the user on a demo-only page (/fims,
    // tools…) or, on a fresh install, with no account at all — always
    // navigate so the root loader re-resolves and lands somewhere valid.
    void navigate(previousAccountId ? '/portfolio' : '/onboarding', { replace: true })
  }

  if (!demo.active || !step) {
    return null
  }

  const devnet = networks.find((network) => network.type === 'solana:devnet')
  const showAirdrop = demo.walletCreated && !demo.airdropRequested && demoAddress && devnet
  // Match by wallet id, not by public key: the demo mnemonic may collide with
  // a wallet the user imported from the same seed — a pubkey lookup would
  // pick (and delete, or sign with) THEIR account.
  const demoAccount = demo.walletId ? accounts.find((account) => account.walletId === demo.walletId) : undefined
  const showMemberRegistration = demo.walletCreated && !demo.memberRegistered && demoAccount

  return (
    <>
      {showAirdrop ? <DemoAirdrop address={demoAddress} network={devnet} /> : null}
      {showMemberRegistration ? <DemoMemberRegistration account={demoAccount} /> : null}
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
