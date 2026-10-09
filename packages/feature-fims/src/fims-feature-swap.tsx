import type { Address } from '@solana/kit'
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
import type { FimsStrategyState } from './data-access/fims-strategy.ts'
import { useFimsMember, useFimsTokens } from './data-access/use-fims.tsx'
import { useFimsCurrency } from './data-access/use-fims-currency.tsx'
import { useFimsDebt } from './data-access/use-fims-debt.tsx'
import { useFimsStrategyState, useFimsStrategySwap, useFimsSwap, useJupiterQuote } from './data-access/use-jupiter.tsx'
import { FIMS_KNOWN_MINTS, FIMS_MAX_PRICE_IMPACT } from './fims-constants.ts'
import { computeFimsTontineCarve } from './fims-debt.ts'
import { getFimsPlatformFeeBps, getFimsTontineRate } from './fims-fee-config.ts'
import { fimsSwappableMints, isSolGasMint } from './fims-gas.ts'
import { reportGasTopupError } from './fims-gas-topup-store.ts'
import { FimsUiLimitOrders } from './fims-ui-limit-orders.tsx'
import { formatTokenUnits, parseTokenUnits } from './fims-units.ts'

export function FimsFeatureSwap({ account }: { account: Account }) {
  const { t } = useTranslation('fims')
  const network = useNetworkActive()
  const balances = useGetTokenBalances({ address: account.publicKey, network })
  const fimsTokens = useFimsTokens()
  const { format, rates } = useFimsCurrency()
  const { member } = useFimsMember(account.publicKey, account)
  const { debt } = useFimsDebt(member, account)
  const debtOwed = debt != null && debt > 0

  const [inputMint, setInputMint] = useState<string>('')
  const [outputMint, setOutputMint] = useState<string>('')
  const [amountText, setAmountText] = useState('')

  const inputToken = useMemo(() => balances.find((b) => b.mint === inputMint), [balances, inputMint])
  const outputTokens = useMemo(
    () => (fimsTokens.data ?? []).filter((token) => token.address && !isSolGasMint(token.address)),
    [fimsTokens.data],
  )
  // Both swap legs are restricted to the FiMs spreadsheet tokens — SOL is
  // gas-only and never appears in the lists.
  const swappableMints = useMemo(() => fimsSwappableMints(fimsTokens.data), [fimsTokens.data])
  const inputBalances = useMemo(() => balances.filter((b) => swappableMints.has(b.mint)), [balances, swappableMints])
  const outputMetadata = useGetTokenMetadataJupiter(outputMint ? [outputMint] : [])
  const outputDecimals = outputMetadata.data?.[0]?.decimals ?? 9
  const outputToken = outputTokens.find((token) => token.address === outputMint)
  const outputSymbol = outputToken?.symbol ?? ''
  // FiMs volatility is normalized 0 (stable) → 1 (most volatile asset tracked).
  const outputVolatility = outputToken?.volatility ?? null
  const riskLevel =
    outputVolatility == null || outputVolatility <= 0 ? 'none' : outputVolatility >= 0.7 ? 'high' : 'moderate'

  const amount = useMemo(() => {
    if (!inputToken || !amountText) return 0n
    try {
      return parseTokenUnits(amountText, inputToken.decimals)
    } catch {
      return 0n
    }
  }, [amountText, inputToken])

  // Tontine carve: while the member owes the tontine, tontineRate of the
  // sent units is diverted to the pot — the quote below runs on what
  // remains. EUR price: FiMs token list first, Jupiter USD price as a
  // fallback for non-listed mints.
  const inputPriceEur = useMemo(() => {
    const fimsPrice = fimsTokens.data?.find((token) => token.address === inputMint)?.value
    if (fimsPrice) return fimsPrice
    const usd = inputToken?.metadata?.usdPrice
    return usd && usd > 0 && rates.usd > 0 ? usd / rates.usd : null
  }, [fimsTokens.data, inputMint, inputToken, rates.usd])
  // Swaps convert in place — the value stays in the position, so only the
  // rate share applies (the position − debt exit rule is for actual sends).
  const tontineAmount = computeFimsTontineCarve({
    amount,
    debt,
    decimals: inputToken?.decimals ?? 9,
    priceEur: inputPriceEur,
    tontineRate: getFimsTontineRate(),
  })
  const swapAmount = amount - tontineAmount

  // Share tokens (FSOL, FLiP…) are issued by the strategy vault, not bought
  // on a market: the quote targets the strategy's collateral mint and the
  // transaction ends with a program `deposit`. Shares arrive ~1 min later
  // via the keeper — the collateral never stays in the wallet.
  const strategyState = useFimsStrategyState({ network })
  const strategyIndex = useMemo(
    () => (strategyState.data?.strategies ?? []).findIndex((s) => s.shareMint === outputMint),
    [strategyState.data, outputMint],
  )
  const strategyRoute = strategyIndex >= 0 ? (strategyState.data?.strategies[strategyIndex] ?? null) : null
  const quoteMint = strategyRoute ? strategyRoute.collateralMint : outputMint

  const quote = useJupiterQuote({
    account,
    amount: swapAmount,
    inputMint,
    network,
    outputMint: quoteMint,
    platformFeeBps: getFimsPlatformFeeBps(),
  })
  const swap = useFimsSwap({ account, network })
  const strategySwap = useFimsStrategySwap({ account, network })
  const [signature, setSignature] = useState<string>('')

  const canSign = account.type !== 'Watched'
  const outAmount = quote.data ? formatTokenUnits(BigInt(quote.data.outAmount), outputDecimals) : null
  const minOut = quote.data ? formatTokenUnits(BigInt(quote.data.otherAmountThreshold), outputDecimals) : null

  // Safety gates that block the swap entirely: a pinned-symbol mint that
  // does not match (tampered token list) and a quote whose price impact
  // blows past the limit (manipulated route or fake liquidity).
  const pinnedMint = outputToken ? FIMS_KNOWN_MINTS[outputToken.symbol] : undefined
  const mintMismatch = Boolean(pinnedMint && pinnedMint !== outputMint)
  const impactPct = quote.data?.priceImpactPct ? Number(quote.data.priceImpactPct) : 0
  const impactBlocked = Number.isFinite(impactPct) && impactPct > FIMS_MAX_PRICE_IMPACT
  const swapBlocked = mintMismatch || impactBlocked

  const handleSwap = async () => {
    if (!quote.data || (strategyRoute && !strategyState.data)) return
    try {
      const sig = strategyRoute
        ? await strategySwap.mutateAsync({
            feeMint: strategyRoute.collateralMint,
            quote: quote.data,
            state: strategyState.data as FimsStrategyState,
            strategyIndex,
            tontineAmount,
          })
        : await swap.mutateAsync({ feeMint: outputMint as Address, quote: quote.data, tontineAmount })
      setSignature(sig)
    } catch (error) {
      reportGasTopupError(error)
      toastError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <div className="space-y-4">
      {debtOwed ? (
        <UiCard title={t(($) => $.debtBlockedTitle)}>
          <p className="text-muted-foreground text-sm">
            {t(($) => $.debtCarveBody, { amount: format(debt), rate: getFimsTontineRate() * 100 })}
          </p>
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
                  {inputBalances.map((token) => (
                    <SelectItem key={token.mint} value={token.mint}>
                      {token.metadata?.symbol ?? 'SOL'} — {formatTokenUnits(token.balance, token.decimals)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!inputBalances.length ? (
                <p className="text-muted-foreground text-xs">{t(($) => $.swapNoSwappableInput)}</p>
              ) : null}
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

          {riskLevel !== 'none' ? (
            <div
              className={`rounded-md border p-3 text-sm ${
                riskLevel === 'high' ? 'border-red-500 text-red-600 dark:text-red-400' : 'border-amber-500'
              }`}
            >
              <UiIcon className="mr-1 inline size-4" icon="alert" />
              {t(($) => (riskLevel === 'high' ? $.swapRiskWarningHigh : $.swapRiskWarning), {
                symbol: outputSymbol,
              })}
            </div>
          ) : null}

          {mintMismatch ? (
            <p className="rounded-md border border-red-500 p-3 text-red-600 text-sm dark:text-red-400">
              <UiIcon className="mr-1 inline size-4" icon="alert" />
              {t(($) => $.swapUnsafeMint, { symbol: outputSymbol })}
            </p>
          ) : null}
          {impactBlocked ? (
            <p className="rounded-md border border-red-500 p-3 text-red-600 text-sm dark:text-red-400">
              <UiIcon className="mr-1 inline size-4" icon="alert" />
              {t(($) => $.swapImpactBlocked, {
                impact: (impactPct * 100).toFixed(2),
                max: (FIMS_MAX_PRICE_IMPACT * 100).toFixed(0),
              })}
            </p>
          ) : null}
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
              <div>
                {t(($) => $.swapPlatformFee)}: {(getFimsPlatformFeeBps() / 100).toFixed(2)}%
              </div>
              <div>
                {t(($) => $.swapTontineFee)}:{' '}
                {tontineAmount > 0n && inputToken
                  ? t(($) => $.swapTontineCarveValue, {
                      amount: formatTokenUnits(tontineAmount, inputToken.decimals),
                      symbol: inputToken.metadata?.symbol ?? '',
                    })
                  : t(($) => $.swapTontineFeeValue, { rate: getFimsTontineRate() * 100 })}
              </div>
              <div>{t(($) => $.swapSlippage)}: 0.5%</div>
              <div>{t(($) => $.swapNetworkFeeEstimate)}: ≈ 0.00005 SOL</div>
              {strategyRoute ? (
                <div className="text-primary text-xs">{t(($) => $.swapViaStrategy, { symbol: outputSymbol })}</div>
              ) : null}
              <div className="text-xs">{t(($) => $.swapFeesIncluded)}</div>
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
            <Button
              disabled={!canSign || !quote.data || swap.isPending || strategySwap.isPending || swapBlocked}
              onClick={handleSwap}
            >
              {swap.isPending || strategySwap.isPending ? <UiLoader className="size-4" /> : null}
              {t(($) => $.swapAction)}
            </Button>
          </div>
          {!canSign ? <p className="text-muted-foreground text-xs">{t(($) => $.swapWatchOnly)}</p> : null}
          <p className="text-muted-foreground text-xs">
            {t(($) => $.swapDisclaimer, { fee: (getFimsPlatformFeeBps() / 100).toFixed(2) })}
          </p>
        </div>
      </UiCard>

      {/* Limit orders are the documented exception — the keeper settles them
          later and cannot carry the carve (same as Solana Pay). */}
      <FimsUiLimitOrders account={account} outputTokens={outputTokens} />
    </div>
  )
}
