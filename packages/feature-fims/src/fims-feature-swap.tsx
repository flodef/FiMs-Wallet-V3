import type { Account } from '@workspace/db/account/account'
import { useNetworkActive } from '@workspace/db-react/use-network-active'
import { useGetTokenBalances } from '@workspace/feature-portfolio/data-access/use-get-token-balances'
import { useTranslation } from '@workspace/i18n'
import { useGetTokenMetadataJupiter } from '@workspace/solana-client-react/use-get-token-metadata-jupiter'
import { Button } from '@workspace/ui/components/button'
import { Input } from '@workspace/ui/components/input'
import { Label } from '@workspace/ui/components/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select'
import { UiCard } from '@workspace/ui/components/ui-card'
import { UiIcon } from '@workspace/ui/components/ui-icon'
import { UiLoader } from '@workspace/ui/components/ui-loader'
import { toastError } from '@workspace/ui/lib/toast-error'
import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { useFimsMember, useFimsTokens } from './data-access/use-fims.tsx'
import { useFimsCurrency } from './data-access/use-fims-currency.tsx'
import { useFimsDebt } from './data-access/use-fims-debt.tsx'
import { useFimsSwap, useJupiterQuote } from './data-access/use-jupiter.tsx'
import { FimsUiLimitOrders } from './fims-ui-limit-orders.tsx'
import { formatTokenUnits, parseTokenUnits } from './fims-units.ts'

export function FimsFeatureSwap({ account }: { account: Account }) {
  const { t } = useTranslation('fims')
  const network = useNetworkActive()
  const balances = useGetTokenBalances({ address: account.publicKey, network })
  const fimsTokens = useFimsTokens()
  const { format } = useFimsCurrency()
  const { member } = useFimsMember(account.publicKey, account)
  const { debt } = useFimsDebt(member, account)
  const debtBlocked = debt != null && debt > 0

  const [inputMint, setInputMint] = useState<string>('')
  const [outputMint, setOutputMint] = useState<string>('')
  const [amountText, setAmountText] = useState('')

  const inputToken = useMemo(() => balances.find((b) => b.mint === inputMint), [balances, inputMint])
  const outputTokens = useMemo(() => (fimsTokens.data ?? []).filter((token) => token.address), [fimsTokens.data])
  const outputMetadata = useGetTokenMetadataJupiter(outputMint ? [outputMint] : [])
  const outputDecimals = outputMetadata.data?.[0]?.decimals ?? 9
  const outputSymbol = outputTokens.find((token) => token.address === outputMint)?.symbol ?? ''

  const amount = useMemo(() => {
    if (!inputToken || !amountText) return 0n
    try {
      return parseTokenUnits(amountText, inputToken.decimals)
    } catch {
      return 0n
    }
  }, [amountText, inputToken])

  const quote = useJupiterQuote({ amount, inputMint, outputMint })
  const swap = useFimsSwap({ account, network })
  const [signature, setSignature] = useState<string>('')

  const canSign = account.type !== 'Watched'
  const outAmount = quote.data ? formatTokenUnits(BigInt(quote.data.outAmount), outputDecimals) : null
  const minOut = quote.data ? formatTokenUnits(BigInt(quote.data.otherAmountThreshold), outputDecimals) : null

  const handleSwap = async () => {
    if (!quote.data) return
    try {
      const sig = await swap.mutateAsync(quote.data)
      setSignature(sig)
    } catch (error) {
      toastError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <div className="space-y-4">
      {debtBlocked ? (
        <UiCard title={t(($) => $.debtBlockedTitle)}>
          <p className="text-muted-foreground text-sm">{t(($) => $.debtBlockedBody, { amount: format(debt) })}</p>
        </UiCard>
      ) : null}
      <UiCard title={t(($) => $.swapTitle)}>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>{t(($) => $.swapFrom)}</Label>
              <Select onValueChange={setInputMint} value={inputMint}>
                <SelectTrigger>
                  <SelectValue placeholder={t(($) => $.swapFromPlaceholder)} />
                </SelectTrigger>
                <SelectContent>
                  {balances.map((token) => (
                    <SelectItem key={token.mint} value={token.mint}>
                      {token.metadata?.symbol ?? 'SOL'} — {formatTokenUnits(token.balance, token.decimals)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t(($) => $.swapAmount)}</Label>
              <div className="flex gap-2">
                <Input
                  inputMode="decimal"
                  onChange={(e) => setAmountText(e.target.value)}
                  placeholder="0.0"
                  value={amountText}
                />
                <Button
                  disabled={!inputToken}
                  onClick={() => inputToken && setAmountText(formatTokenUnits(inputToken.balance, inputToken.decimals))}
                  variant="outline"
                >
                  {t(($) => $.swapMax)}
                </Button>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <Label>{t(($) => $.swapTo)}</Label>
            <Select onValueChange={setOutputMint} value={outputMint}>
              <SelectTrigger>
                <SelectValue placeholder={t(($) => $.swapToPlaceholder)} />
              </SelectTrigger>
              <SelectContent>
                {outputTokens.map((token) => (
                  <SelectItem key={token.address ?? token.symbol} value={token.address ?? ''}>
                    {token.symbol} — {token.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {quote.isFetching ? <UiLoader className="size-6" /> : null}
          {quote.isError ? <p className="text-destructive text-sm">{t(($) => $.swapQuoteError)}</p> : null}
          {quote.data ? (
            <div className="space-y-1 text-muted-foreground text-sm">
              <div>
                {t(($) => $.swapReceive)} ≈ {outAmount} {outputSymbol}
              </div>
              <div>
                {t(($) => $.swapMinReceived)}: {minOut} {outputSymbol}
              </div>
              {quote.data.priceImpactPct ? (
                <div>
                  {t(($) => $.swapPriceImpact)}: {(Number(quote.data.priceImpactPct) * 100).toFixed(2)}%
                </div>
              ) : null}
            </div>
          ) : null}

          {signature ? (
            <p className="text-sm">
              <UiIcon className="mr-1 inline size-4 text-green-500" icon="check" />
              {t(($) => $.swapSuccess)}{' '}
              <Link className="text-primary underline" to={`/explorer/tx/${signature}`}>
                {t(($) => $.swapViewTx)}
              </Link>
            </p>
          ) : null}

          <div className="flex justify-end">
            <Button disabled={!canSign || !quote.data || swap.isPending || debtBlocked} onClick={handleSwap}>
              {swap.isPending ? <UiLoader className="size-4" /> : null}
              {t(($) => $.swapAction)}
            </Button>
          </div>
          {!canSign ? <p className="text-muted-foreground text-xs">{t(($) => $.swapWatchOnly)}</p> : null}
          <p className="text-muted-foreground text-xs">{t(($) => $.swapDisclaimer)}</p>
        </div>
      </UiCard>

      <FimsUiLimitOrders account={account} debtBlocked={debtBlocked} outputTokens={outputTokens} />
    </div>
  )
}
