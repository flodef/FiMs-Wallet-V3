import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select'

import { useFimsCurrency } from './data-access/use-fims-currency.tsx'

export function FimsUiCurrencySelect() {
  const { currency, setCurrency } = useFimsCurrency()
  return (
    <Select onValueChange={(value) => setCurrency(value)} value={currency}>
      <SelectTrigger className="h-7 w-20 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="EUR">EUR</SelectItem>
        <SelectItem value="USD">USD</SelectItem>
      </SelectContent>
    </Select>
  )
}
