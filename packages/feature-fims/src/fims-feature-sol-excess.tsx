import type { Address } from '@solana/kit'
import { useQueryClient } from '@tanstack/react-query'
import { useAccountActive } from '@workspace/db-react/use-account-active'
import { useNetworkActive } from '@workspace/db-react/use-network-active'
import { useGetTokenBalances } from '@workspace/feature-portfolio/data-access/use-get-token-balances'
import { useTranslation } from '@workspace/i18n'
import { formatLamports } from '@workspace/i18n/format'
import { NATIVE_MINT } from '@workspace/solana-client/constants'
import { Button } from '@workspace/ui/components/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@workspace/ui/components/dialog'
import { UiLoader } from '@workspace/ui/components/ui-loader'
import { toastError } from '@workspace/ui/lib/toast-error'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useFimsStrategyState, useFimsStrategySwap, useJupiterQuote } from './data-access/use-jupiter.tsx'
import { FIMS_FSOL_MINT, FIMS_SOL_GAS_RESERVE } from './fims-constants.ts'
import { getFimsPlatformFeeBps } from './fims-fee-config.ts'
import { solExcessAboveReserve } from './fims-gas.ts'
import { reportGasTopupError } from './fims-gas-topup-store.ts'
import { formatTokenUnits } from './fims-units.ts'

// SOL deposited by accident sits idle — the wallet only needs
// FIMS_SOL_GAS_RESERVE for gas. When more than that is detected, propose
// once per session to convert the excess into FSOL (FiMs' own SOL wrapper,
// a spreadsheet token that stays swappable back).
export function FimsFeatureSolExcess() {
  const { t } = useTranslation('fims')
  const account = useAccountActive()
  const network = useNetworkActive()
  const queryClient = useQueryClient()
  const balances = useGetTokenBalances({ address: account.publicKey, network })

  const solBalance = useMemo(() => balances.find((b) => b.mint === NATIVE_MINT)?.balance ?? 0n, [balances])
  const excess = solExcessAboveReserve(solBalance)

  // Share tokens (FSOL…) are issued by the strategy vault, not bought on a
  // market: Jupiter has no route for them. The conversion means swapping the
  // SOL into the strategy's collateral mint, then a program `deposit` in the
  // same transaction — the same route the swap page takes. No deployed
  // strategy, no proposal: the tile stays silent instead of erroring.
  const strategyState = useFimsStrategyState({ network })
  const strategyIndex = useMemo(
    () => (strategyState.data?.strategies ?? []).findIndex((s) => s.shareMint === FIMS_FSOL_MINT),
    [strategyState.data],
  )
  const strategy = strategyIndex >= 0 ? strategyState.data?.strategies[strategyIndex] : null
  const swap = useFimsStrategySwap({ account, network })

  const [open, setOpen] = useState(false)
  const prompted = useRef(false)
  useEffect(() => {
    // Only propose a meaningful excess (above ~10% of the reserve) and only
    // once per session — the user can always convert manually later.
    if (!prompted.current && excess > FIMS_SOL_GAS_RESERVE / 10n && account.type !== 'Watched' && strategy) {
      prompted.current = true
      setOpen(true)
    }
  }, [excess, account.type, strategy])

  const quote = useJupiterQuote({
    account,
    amount: excess,
    inputMint: open && strategy ? NATIVE_MINT : undefined,
    network,
    outputMint: strategy?.collateralMint,
    platformFeeBps: getFimsPlatformFeeBps(),
  })
  const [signature, setSignature] = useState('')

  const handleConvert = async () => {
    if (!quote.data || !strategyState.data) {
      return
    }
    try {
      const sig = await swap.mutateAsync({
        feeMint: FIMS_FSOL_MINT as Address,
        quote: quote.data,
        state: strategyState.data,
        strategyIndex,
      })
      setSignature(sig)
      await queryClient.invalidateQueries()
      setOpen(false)
    } catch (error) {
      reportGasTopupError(error)
      toastError(error)
    }
  }

  const outAmount = quote.data ? formatTokenUnits(BigInt(quote.data.outAmount), 9) : null

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t(($) => $.solExcessTitle)}</DialogTitle>
          <DialogDescription>
            {t(($) => $.solExcessBody, {
              excess: formatLamports(excess),
              reserve: formatLamports(FIMS_SOL_GAS_RESERVE),
            })}
          </DialogDescription>
        </DialogHeader>
        {signature ? (
          <p className="text-green-600 text-sm dark:text-green-400">{t(($) => $.solExcessSuccess)}</p>
        ) : (
          <div className="space-y-1 text-muted-foreground text-sm">
            {quote.isFetching ? <UiLoader className="size-6" /> : null}
            {quote.isError ? <p className="text-destructive">{t(($) => $.solExcessQuoteError)}</p> : null}
            {outAmount ? (
              <>
                <div>
                  {t(($) => $.solExcessReceive)} ≈ {outAmount} FSOL
                </div>
                <div>
                  {t(($) => $.swapPlatformFee)}: {(getFimsPlatformFeeBps() / 100).toFixed(2)}%
                </div>
              </>
            ) : null}
          </div>
        )}
        <DialogFooter>
          <Button onClick={() => setOpen(false)} variant="ghost">
            {t(($) => $.solExcessLater)}
          </Button>
          <Button disabled={!quote.data || swap.isPending || !!signature} onClick={handleConvert}>
            {swap.isPending ? <UiLoader className="size-4" /> : null}
            {t(($) => $.solExcessAction)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
