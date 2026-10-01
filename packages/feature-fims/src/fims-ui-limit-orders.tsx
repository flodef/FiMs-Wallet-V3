import type { Account } from '@workspace/db/account/account'
import { useNetworkActive } from '@workspace/db-react/use-network-active'
import { useGetTokenBalances } from '@workspace/feature-portfolio/data-access/use-get-token-balances'
import { useTranslation } from '@workspace/i18n'
import { Button } from '@workspace/ui/components/button'
import { Input } from '@workspace/ui/components/input'
import { Label } from '@workspace/ui/components/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@workspace/ui/components/table'
import { UiCard } from '@workspace/ui/components/ui-card'
import { UiLoader } from '@workspace/ui/components/ui-loader'
import { toastError } from '@workspace/ui/lib/toast-error'
import { useMemo, useState } from 'react'
import {
  useFimsTriggerCancelOrder,
  useFimsTriggerCreateOrder,
  useFimsTriggerOrders,
} from './data-access/use-jupiter.tsx'
import type { FimsToken } from './fims-api.ts'
import { formatTokenUnits, parseTokenUnits } from './fims-units.ts'

export function FimsUiLimitOrders({ account, outputTokens }: { account: Account; outputTokens: FimsToken[] }) {
  const { t } = useTranslation('fims')
  const network = useNetworkActive()
  const balances = useGetTokenBalances({ address: account.publicKey, network })
  const orders = useFimsTriggerOrders({ account })
  const createOrder = useFimsTriggerCreateOrder({ account, network })
  const cancelOrder = useFimsTriggerCancelOrder({ account, network })

  const [inputMint, setInputMint] = useState('')
  const [outputMint, setOutputMint] = useState('')
  const [sellAmount, setSellAmount] = useState('')
  const [receiveAmount, setReceiveAmount] = useState('')

  const inputToken = useMemo(() => balances.find((b) => b.mint === inputMint), [balances, inputMint])
  const outputToken = useMemo(
    () => outputTokens.find((token) => token.address === outputMint),
    [outputTokens, outputMint],
  )
  const outputDecimals = 9

  const canSign = account.type !== 'Watched'

  const handleCreate = async () => {
    if (!inputToken || !outputMint || !sellAmount || !receiveAmount) return
    try {
      await createOrder.mutateAsync({
        inputMint,
        makingAmount: parseTokenUnits(sellAmount, inputToken.decimals),
        outputMint,
        takingAmount: parseTokenUnits(receiveAmount, outputDecimals),
      })
      setSellAmount('')
      setReceiveAmount('')
      await orders.refetch()
    } catch (error) {
      toastError(error instanceof Error ? error.message : String(error))
    }
  }

  const handleCancel = async (orderKey: string) => {
    try {
      await cancelOrder.mutateAsync(orderKey)
      await orders.refetch()
    } catch (error) {
      toastError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <UiCard title={t(($) => $.limitTitle)}>
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
            <Input
              inputMode="decimal"
              onChange={(e) => setSellAmount(e.target.value)}
              placeholder={t(($) => $.limitSellAmount)}
              value={sellAmount}
            />
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
            <Input
              inputMode="decimal"
              onChange={(e) => setReceiveAmount(e.target.value)}
              placeholder={t(($) => $.limitReceiveAmount)}
              value={receiveAmount}
            />
          </div>
        </div>

        <div className="flex justify-end">
          <Button
            disabled={!canSign || !inputToken || !outputToken || !sellAmount || !receiveAmount || createOrder.isPending}
            onClick={handleCreate}
          >
            {createOrder.isPending ? <UiLoader className="size-4" /> : null}
            {t(($) => $.limitCreate)}
          </Button>
        </div>

        {orders.data?.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t(($) => $.limitSellAmount)}</TableHead>
                <TableHead>{t(($) => $.limitReceiveAmount)}</TableHead>
                <TableHead className="text-right">{t(($) => $.addressBookActions)}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.data.map((order) => (
                <TableRow key={order.orderKey ?? `${order.inputMint}-${order.makingAmount}`}>
                  <TableCell className="font-mono text-xs">
                    {order.makingAmount ?? '—'} {order.inputMint ? `(${order.inputMint.slice(0, 4)}…)` : ''}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {order.takingAmount ?? '—'} {order.outputMint ? `(${order.outputMint.slice(0, 4)}…)` : ''}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      disabled={!canSign || !order.orderKey || cancelOrder.isPending}
                      onClick={() => order.orderKey && handleCancel(order.orderKey)}
                      size="sm"
                      variant="outline"
                    >
                      {t(($) => $.limitCancel)}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : orders.isLoading ? (
          <UiLoader className="size-6" />
        ) : null}
      </div>
    </UiCard>
  )
}
