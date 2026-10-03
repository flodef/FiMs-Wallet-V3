import type { Address } from '@solana/kit'
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token'
import { useMutation } from '@tanstack/react-query'
import type { Account } from '@workspace/db/account/account'
import type { Network } from '@workspace/db/network/network'
import type { SendOverrideContext } from '@workspace/feature-portfolio/portfolio-modals'
import { PortfolioUiTokenBalanceItem } from '@workspace/feature-portfolio/ui/portfolio-ui-token-balance-item'
import { useTranslation } from '@workspace/i18n'
import { bigIntToDecimal } from '@workspace/solana-client/big-int-to-decimal'
import { NATIVE_MINT } from '@workspace/solana-client/constants'
import { uiAmountToBigInt } from '@workspace/solana-client/ui-amount-to-big-int'
import { Button } from '@workspace/ui/components/button'
import { Field, FieldGroup, FieldSet } from '@workspace/ui/components/field'
import { UiLoader } from '@workspace/ui/components/ui-loader'
import { UiWarning } from '@workspace/ui/components/ui-warning'
import { ellipsify } from '@workspace/ui/lib/ellipsify'
import { toastError } from '@workspace/ui/lib/toast-error'
import { useNavigate } from 'react-router'
import { useFimsSwapTo, useJupiterQuote } from './data-access/use-jupiter.tsx'
import type { WithdrawalTarget } from './data-access/use-withdrawal-targets.tsx'
import { FIMS_KNOWN_MINTS, FIMS_MAX_PRICE_IMPACT, FIMS_MINT_DECIMALS } from './fims-constants.ts'

// Confirmation screen shown when the picked destination does not accept the
// outgoing token (e.g. sending JUP to a Jupiter Spend address that only takes
// USDC/USDT). The preferred accepted asset is auto-selected and the send is
// routed through a single Jupiter swap whose output lands directly in the
// destination's token account.
export function FimsFeatureSendConvert({
  account,
  amount,
  destination,
  mint,
  network,
  target,
}: {
  account: Account
  amount: string
  destination: Address
  mint: SendOverrideContext['mint']
  network: Network
  target: WithdrawalTarget
}) {
  const { t } = useTranslation('fims')
  const navigate = useNavigate()
  const outputSymbol = target.acceptedSymbols[0]
  const outputMint = outputSymbol ? (FIMS_KNOWN_MINTS[outputSymbol] as Address) : undefined
  const inputAmount = mint.mint === NATIVE_MINT ? uiAmountToBigInt(amount, 9) : uiAmountToBigInt(amount, mint.decimals)
  const quote = useJupiterQuote({ amount: inputAmount, inputMint: mint.mint, outputMint })
  const swapTo = useFimsSwapTo({ account, network })
  const impactPct = quote.data?.priceImpactPct ? Number(quote.data.priceImpactPct) : 0
  const impactBlocked = impactPct > FIMS_MAX_PRICE_IMPACT
  const outputDecimals = (outputSymbol && FIMS_MINT_DECIMALS[outputSymbol]) || 6
  const outAmount = quote.data ? bigIntToDecimal(BigInt(quote.data.otherAmountThreshold), outputDecimals) : undefined

  const confirm = useMutation({
    mutationFn: async () => {
      if (!quote.data || !outputMint) {
        throw new Error('No quote')
      }
      // Deliver the swapped output straight to the destination's ATA. Jupiter
      // emits the ATA-creation instruction inside the same transaction when
      // the account does not exist yet.
      const [destinationTokenAccount] = await findAssociatedTokenPda({
        mint: outputMint,
        owner: destination,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      })
      return swapTo.mutateAsync({ destinationTokenAccount, quote: quote.data })
    },
    onError: (error) => toastError(`Swap + send failed: ${error.message}`),
    onSuccess: async (signature) => {
      if (signature) {
        await navigate(`/modals/complete/${signature}`)
      }
    },
  })

  return (
    <FieldGroup>
      <FieldSet>
        <PortfolioUiTokenBalanceItem item={mint} />
        <div className="rounded-md border p-3 text-sm">
          <div className="text-muted-foreground">{t(($) => $.sendConvertDestination)}</div>
          <div className="font-medium">{target.label}</div>
          <div className="break-all font-mono text-muted-foreground text-xs">{destination}</div>
        </div>
        <UiWarning>
          {t(($) => $.sendConvertNotice, { accepted: target.acceptedSymbols.join(', '), label: target.label })}
        </UiWarning>
        {quote.isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <UiLoader className="size-4" />
            {t(($) => $.sendConvertQuoting)}
          </div>
        ) : quote.error ? (
          <UiWarning>{t(($) => $.sendConvertQuoteFailed)}</UiWarning>
        ) : outAmount !== undefined ? (
          <div className="space-y-1 text-sm">
            <div>
              {t(($) => $.sendConvertResult, {
                amount: outAmount.toLocaleString(undefined, { maximumFractionDigits: outputDecimals }),
                symbol: outputSymbol ?? '',
              })}
            </div>
            <div className="text-muted-foreground">
              {t(($) => $.swapPriceImpact)}: {(impactPct * 100).toFixed(2)}%
            </div>
          </div>
        ) : null}
        {impactBlocked ? <UiWarning>{t(($) => $.swapPriceImpactBlocked)}</UiWarning> : null}
      </FieldSet>
      <Field className="flex justify-end" orientation="horizontal">
        <Button disabled={!quote.data || impactBlocked || confirm.isPending} onClick={() => confirm.mutate()}>
          {confirm.isPending ? <UiLoader className="size-4" /> : null}
          {t(($) => $.sendConvertConfirm, { destination: ellipsify(destination, 4, '…') })}
        </Button>
      </Field>
    </FieldGroup>
  )
}
