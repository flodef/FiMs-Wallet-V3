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
import { Label } from '@workspace/ui/components/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select'
import { UiLoader } from '@workspace/ui/components/ui-loader'
import { toastError } from '@workspace/ui/lib/toast-error'
import { useMemo, useState } from 'react'
import { useFimsTokens } from './data-access/use-fims.tsx'
import { useFimsSwap, useJupiterQuote } from './data-access/use-jupiter.tsx'
import { fimsSwappableMints, solGasDeficit } from './fims-gas.ts'
import { closeGasTopup, useGasTopupOpen } from './fims-gas-topup-store.ts'
import { formatTokenUnits } from './fims-units.ts'

// Gas top-up: when a transaction fails because the wallet is out of SOL,
// explain why SOL is needed and offer to convert part of an existing token
// back into roughly the missing amount (up to the 0.01 SOL reserve).
// This is a recovery operation, not a conversion — no platform fee applies.
export function FimsFeatureGasTopup() {
  const { t } = useTranslation('fims')
  const account = useAccountActive()
  const network = useNetworkActive()
  const queryClient = useQueryClient()
  const open = useGasTopupOpen()
  const balances = useGetTokenBalances({ address: account.publicKey, network })
  const fimsTokens = useFimsTokens()
  const swap = useFimsSwap({ account, network })

  const solBalance = useMemo(() => balances.find((b) => b.mint === NATIVE_MINT)?.balance ?? 0n, [balances])
  const deficit = solGasDeficit(solBalance)

  const swappableMints = useMemo(() => fimsSwappableMints(fimsTokens.data), [fimsTokens.data])
  const candidates = useMemo(
    () => balances.filter((b) => swappableMints.has(b.mint) && b.balance > 0n),
    [balances, swappableMints],
  )
  const [sourceMint, setSourceMint] = useState('')
  const sourceToken = candidates.find((b) => b.mint === sourceMint)

  // Approximate top-up: quote how much of the chosen token the missing
  // lamports are worth (SOL -> token), then swap that token amount back to
  // SOL. The result lands within slippage of the 0.01 reserve — good enough
  // for gas.
  const target = deficit > 0n ? deficit : 10_000_000n
  const estimate = useJupiterQuote({
    account,
    amount: target,
    inputMint: NATIVE_MINT,
    network,
    outputMint: sourceMint || undefined,
  })
  const topupAmount = estimate.data ? BigInt(estimate.data.outAmount) : 0n
  const quote = useJupiterQuote({
    account,
    amount: topupAmount,
    inputMint: sourceMint,
    network,
    outputMint: NATIVE_MINT,
  })
  const [signature, setSignature] = useState('')

  const handleTopup = async () => {
    if (!quote.data) {
      return
    }
    try {
      // No feeMint: refilling gas is a recovery operation, not a conversion.
      const sig = await swap.mutateAsync({ quote: quote.data })
      setSignature(sig)
      await queryClient.invalidateQueries()
      closeGasTopup()
    } catch (error) {
      toastError(error instanceof Error ? error.message : String(error))
    }
  }

  const inAmount =
    quote.data && sourceToken ? formatTokenUnits(BigInt(quote.data.inAmount), sourceToken.decimals) : null
  const outSol = quote.data ? lamportsToSol(BigInt(quote.data.outAmount)) : null

  return (
    <Dialog onOpenChange={(next) => !next && closeGasTopup()} open={open}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t(($) => $.gasTopupTitle)}</DialogTitle>
          <DialogDescription>{t(($) => $.gasTopupBody, { reserve: lamportsToSol(10_000_000n) })}</DialogDescription>
        </DialogHeader>
        {signature ? (
          <p className="text-green-600 text-sm dark:text-green-400">{t(($) => $.gasTopupSuccess)}</p>
        ) : candidates.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t(($) => $.gasTopupNoTokens)}</p>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>{t(($) => $.gasTopupSource)}</Label>
              <Select onValueChange={setSourceMint} value={sourceMint}>
                <SelectTrigger>
                  <SelectValue placeholder={t(($) => $.gasTopupSourcePlaceholder)} />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((token) => (
                    <SelectItem key={token.mint} value={token.mint}>
                      {token.metadata?.symbol ?? token.mint.slice(0, 4)} —{' '}
                      {formatTokenUnits(token.balance, token.decimals)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {sourceToken ? (
              estimate.isFetching || quote.isFetching ? (
                <UiLoader className="size-6" />
              ) : estimate.isError || quote.isError ? (
                <p className="text-destructive text-sm">{t(($) => $.gasTopupQuoteError)}</p>
              ) : inAmount && outSol ? (
                <p className="text-muted-foreground text-sm">
                  {t(($) => $.gasTopupCost, {
                    amount: inAmount,
                    sol: outSol,
                    symbol: sourceToken.metadata?.symbol ?? '',
                  })}
                </p>
              ) : null
            ) : null}
          </div>
        )}
        <DialogFooter>
          <Button onClick={closeGasTopup} variant="ghost">
            {t(($) => $.gasTopupLater)}
          </Button>
          <Button disabled={!quote.data || swap.isPending || !!signature} onClick={handleTopup}>
            {swap.isPending ? <UiLoader className="size-4" /> : null}
            {t(($) => $.gasTopupAction)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
