import type { Address } from '@solana/kit'
import type { Account } from '@workspace/db/account/account'
import { useNetworkActive } from '@workspace/db-react/use-network-active'
import { ExplorerUiTxExternalLink } from '@workspace/feature-explorer/ui/explorer-ui-tx-external-link'
import { useGetTokenBalances } from '@workspace/feature-portfolio/data-access/use-get-token-balances'
import { useTranslation } from '@workspace/i18n'
import { useGetTokenMetadataJupiter } from '@workspace/solana-client-react/use-get-token-metadata-jupiter'
import { Button } from '@workspace/ui/components/button'
import { UiCard } from '@workspace/ui/components/ui-card'
import { UiIcon } from '@workspace/ui/components/ui-icon'
import { UiLoader } from '@workspace/ui/components/ui-loader'
import { toastError } from '@workspace/ui/lib/toast-error'
import { useMemo, useState } from 'react'
import type { FimsStrategyState } from './data-access/fims-strategy.ts'
import { useFimsMember, useFimsTokens } from './data-access/use-fims.tsx'
import { useFimsCurrency } from './data-access/use-fims-currency.tsx'
import { useFimsRealized } from './data-access/use-fims-realized.tsx'
import { useFimsStrategyState, useFimsStrategySwap, useFimsSwap, useJupiterQuote } from './data-access/use-jupiter.tsx'
import { FIMS_KNOWN_MINTS, FIMS_MAX_PRICE_IMPACT } from './fims-constants.ts'
import { getFimsPlatformFeeBps, getFimsTontineRate } from './fims-fee-config.ts'
import { fimsSwappableMints, isSolGasMint } from './fims-gas.ts'
import { reportGasTopupError } from './fims-gas-topup-store.ts'
import { computeFimsRealizedCarve, fimsBasisKey } from './fims-realized.ts'
import { FimsUiConverter } from './fims-ui-converter.tsx'
import { FimsUiLimitOrders } from './fims-ui-limit-orders.tsx'
import { type FimsTokenOption, FimsUiTokenAmountInput } from './fims-ui-token-amount-input.tsx'
import { formatTokenUnits, parseTokenUnits } from './fims-units.ts'

export function FimsFeatureSwap({ account }: { account: Account }) {
  const { t } = useTranslation('fims')
  const network = useNetworkActive()
  const balances = useGetTokenBalances({ address: account.publicKey, network })
  const fimsTokens = useFimsTokens()
  const { format, rates } = useFimsCurrency()
  const { member } = useFimsMember(account.publicKey, account)
  const { basis, isLoading: basisLoading } = useFimsRealized(member, account, network)

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
  // Icons and decimals for every candidate output come from one batched
  // metadata call — the token chips and the quote need them anyway.
  const outputMints = useMemo(
    () => outputTokens.map((token) => token.address).filter((address): address is string => !!address),
    [outputTokens],
  )
  const outputMetadata = useGetTokenMetadataJupiter(outputMints)
  const metaByMint = useMemo(
    () => new Map((outputMetadata.data ?? []).map((meta) => [meta.id, meta])),
    [outputMetadata.data],
  )
  const outputDecimals = metaByMint.get(outputMint)?.decimals ?? 9
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

  // Tontine carve: the member's share is taken on the gain realized by THIS
  // exit — units out × (current price − cost basis) — and the quote below
  // runs on what remains. EUR price: FiMs token list first, Jupiter USD
  // price as a fallback for non-listed mints.
  const inputPriceEur = useMemo(() => {
    const fimsPrice = fimsTokens.data?.find((token) => token.address === inputMint)?.value
    if (fimsPrice) return fimsPrice
    const usd = inputToken?.metadata?.usdPrice
    return usd && usd > 0 && rates.usd > 0 ? usd / rates.usd : null
  }, [fimsTokens.data, inputMint, inputToken, rates.usd])
  const avgBuyEur = member ? (basis.get(fimsBasisKey(inputMint || null)) ?? null) : null
  const tontineAmount = computeFimsRealizedCarve({
    amount,
    avgBuyEur,
    priceEur: inputPriceEur,
    tontineRate: member ? getFimsTontineRate() : 0,
  })
  const swapAmount = amount - tontineAmount
  // Estimated gain on the outgoing units — shown next to the carve so the
  // member sees what the share is computed on. Null when unpriced.
  const gainEur = useMemo(() => {
    if (!inputToken || inputPriceEur == null) return null
    const units = Number(amount) / 10 ** inputToken.decimals
    return units * Math.max(0, inputPriceEur - (avgBuyEur ?? 0))
  }, [amount, avgBuyEur, inputPriceEur, inputToken])

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

  // Panel options: the "you pay" side lists held swappable tokens (plus the
  // reversed-in mint when it is not held — quote simply cannot build then);
  // the "you receive" side lists every FiMs token with its icon.
  const inputOptions = useMemo(() => {
    const options: FimsTokenOption[] = inputBalances.map((token) => ({
      balance: formatTokenUnits(token.balance, token.decimals),
      icon: token.metadata?.icon ?? null,
      symbol: token.metadata?.symbol ?? 'SOL',
      value: token.mint,
    }))
    if (inputMint && !options.some((option) => option.value === inputMint)) {
      const meta = metaByMint.get(inputMint)
      const fims = outputTokens.find((token) => token.address === inputMint)
      options.push({
        balance: '0',
        icon: meta?.icon ?? null,
        symbol: fims?.symbol ?? meta?.symbol ?? `${inputMint.slice(0, 4)}…`,
        value: inputMint,
      })
    }
    return options
  }, [inputBalances, inputMint, metaByMint, outputTokens])
  const outputOptions = useMemo(
    () =>
      outputTokens.map((token) => ({
        icon: token.address ? (metaByMint.get(token.address)?.icon ?? null) : null,
        label: token.label,
        symbol: token.symbol,
        value: token.address ?? '',
      })),
    [outputTokens, metaByMint],
  )
  const canReverse = Boolean(inputMint && outputMint)
  const handleReverse = () => {
    setInputMint(outputMint)
    setOutputMint(inputMint)
  }

  // Fiat estimates under each panel — same pricing sources as the carve.
  const inputValueEur =
    inputToken && inputPriceEur != null ? (Number(amount) / 10 ** inputToken.decimals) * inputPriceEur : null
  const outputPriceEur = useMemo(() => {
    if (outputToken?.value != null && outputToken.value > 0) return outputToken.value
    const usd = metaByMint.get(outputMint)?.usdPrice
    return usd != null && usd > 0 && rates.usd > 0 ? usd / rates.usd : null
  }, [metaByMint, outputMint, outputToken, rates.usd])
  const outputValueEur = outAmount && outputPriceEur != null ? Number(outAmount) * outputPriceEur : null

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
      toastError(error)
    }
  }

  return (
    <div className="space-y-4">
      {member && basisLoading ? (
        <p className="text-muted-foreground text-sm">
          <UiLoader className="mr-1 inline size-4" />
          {t(($) => $.gainCheckPending)}
        </p>
      ) : null}
      <UiCard title={t(($) => $.swapTitle)}>
        <div className="space-y-4">
          <div className="space-y-1">
            <FimsUiTokenAmountInput
              amount={amountText}
              balance={inputToken ? formatTokenUnits(inputToken.balance, inputToken.decimals) : null}
              label={t(($) => $.swapFrom)}
              onAmountChange={setAmountText}
              onHalf={
                inputToken
                  ? () => setAmountText(formatTokenUnits(inputToken.balance / 2n, inputToken.decimals))
                  : undefined
              }
              onMax={
                inputToken ? () => setAmountText(formatTokenUnits(inputToken.balance, inputToken.decimals)) : undefined
              }
              onTokenChange={setInputMint}
              options={inputOptions}
              tokenPlaceholder={t(($) => $.swapFromPlaceholder)}
              tokenValue={inputMint}
              valueText={inputValueEur != null ? `≈ ${format(inputValueEur)}` : null}
            />
            {!inputBalances.length ? (
              <p className="text-muted-foreground text-xs">{t(($) => $.swapNoSwappableInput)}</p>
            ) : null}
            <div className="flex justify-center">
              <Button
                aria-label={t(($) => $.swapReverse)}
                className="rounded-full"
                disabled={!canReverse}
                onClick={handleReverse}
                size="icon"
                variant="outline"
              >
                <UiIcon className="size-4" icon="arrowDown" />
              </Button>
            </div>
            <FimsUiTokenAmountInput
              amount={quote.isFetching ? '…' : (outAmount ?? '')}
              label={t(($) => $.swapReceive)}
              onTokenChange={setOutputMint}
              options={outputOptions}
              readOnly
              tokenPlaceholder={t(($) => $.swapToPlaceholder)}
              tokenValue={outputMint}
              valueText={outputValueEur != null ? `≈ ${format(outputValueEur)}` : null}
            />
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
              {member && gainEur != null ? (
                <div>
                  {t(($) => $.swapGainEstimate)}: {format(gainEur)}
                </div>
              ) : null}
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
              <ExplorerUiTxExternalLink className="text-primary underline" signature={signature}>
                {t(($) => $.swapViewTx)}
              </ExplorerUiTxExternalLink>
            </p>
          ) : null}

          <div className="flex justify-end">
            <Button
              disabled={
                !canSign ||
                !quote.data ||
                swap.isPending ||
                strategySwap.isPending ||
                swapBlocked ||
                (member != null && basisLoading)
              }
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
      <FimsUiLimitOrders account={account} metaByMint={metaByMint} outputTokens={outputTokens} />

      {/* The converter lives here (not in Community): same swap-style UI,
          display-only — no transaction is created. */}
      <FimsUiConverter metaByMint={metaByMint} />
    </div>
  )
}
