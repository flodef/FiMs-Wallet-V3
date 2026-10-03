import type { Address } from '@solana/kit'
import { useQueryClient } from '@tanstack/react-query'
import { useAccountActive } from '@workspace/db-react/use-account-active'
import { useNetworkActive } from '@workspace/db-react/use-network-active'
import { useGetTokenBalances } from '@workspace/feature-portfolio/data-access/use-get-token-balances'
import { useTranslation } from '@workspace/i18n'
import { NATIVE_MINT } from '@workspace/solana-client/constants'
import { lamportsToSol } from '@workspace/solana-client/lamports-to-sol'
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
import { useFimsSwap, useJupiterQuote } from './data-access/use-jupiter.tsx'
import { FIMS_JUPSOL_MINT, FIMS_PLATFORM_FEE_BPS, FIMS_SOL_GAS_RESERVE } from './fims-constants.ts'
import { solExcessAboveReserve } from './fims-gas.ts'
import { reportGasTopupError } from './fims-gas-topup-store.ts'
import { formatTokenUnits } from './fims-units.ts'

// SOL deposited by accident sits idle — the wallet only needs
// FIMS_SOL_GAS_RESERVE for gas. When more than that is detected, propose
// once per session to convert the excess into JupSOL (keeps SOL exposure,
// liquid staking receipt token that is itself a swappable asset).
export function FimsFeatureSolExcess() {
  const { t } = useTranslation('fims')
  const account = useAccountActive()
  const network = useNetworkActive()
  const queryClient = useQueryClient()
  const balances = useGetTokenBalances({ address: account.publicKey, network })
  const swap = useFimsSwap({ account, network })

  const solBalance = useMemo(() => balances.find((b) => b.mint === NATIVE_MINT)?.balance ?? 0n, [balances])
  const excess = solExcessAboveReserve(solBalance)

  const [open, setOpen] = useState(false)
  const prompted = useRef(false)
  useEffect(() => {
    // Only propose a meaningful excess (above ~10% of the reserve) and only
    // once per session — the user can always convert manually later.
    if (!prompted.current && excess > FIMS_SOL_GAS_RESERVE / 10n && account.type !== 'Watched') {
      prompted.current = true
      setOpen(true)
    }
  }, [excess, account.type])

  const quote = useJupiterQuote({
    amount: excess,
    inputMint: open ? NATIVE_MINT : undefined,
    outputMint: FIMS_JUPSOL_MINT,
    platformFeeBps: FIMS_PLATFORM_FEE_BPS,
  })
  const [signature, setSignature] = useState('')

  const handleConvert = async () => {
    if (!quote.data) {
      return
    }
    try {
      const sig = await swap.mutateAsync({ feeMint: FIMS_JUPSOL_MINT as Address, quote: quote.data })
      setSignature(sig)
      await queryClient.invalidateQueries()
      setOpen(false)
    } catch (error) {
      reportGasTopupError(error)
      toastError(error instanceof Error ? error.message : String(error))
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
              excess: lamportsToSol(excess),
              reserve: lamportsToSol(FIMS_SOL_GAS_RESERVE),
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
                  {t(($) => $.solExcessReceive)} ≈ {outAmount} JupSOL
                </div>
                <div>
                  {t(($) => $.swapPlatformFee)}: {(FIMS_PLATFORM_FEE_BPS / 100).toFixed(1)}%
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
