import { zodResolver } from '@hookform/resolvers/zod'
import type { Address } from '@solana/kit'
import { solanaAddressSchema } from '@workspace/db/solana/solana-address-schema'
import { useTranslation } from '@workspace/i18n'
import { Alert, AlertDescription, AlertTitle } from '@workspace/ui/components/alert'
import { Button } from '@workspace/ui/components/button'
import { Field, FieldGroup, FieldLabel, FieldSet } from '@workspace/ui/components/field'
import { Form, FormField, FormItem, FormMessage } from '@workspace/ui/components/form'
import { Input } from '@workspace/ui/components/input'
import { UiIcon } from '@workspace/ui/components/ui-icon'
import { UiLoader } from '@workspace/ui/components/ui-loader'
import { useEffect, useId } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { usePortfolioPricing } from '../data-access/portfolio-pricing.tsx'

// Burn is reserved for dust and spam tokens (< BURN_MAX_VALUE_EUR — the menu
// and this modal's caller both enforce it). Burning is a one-way operation:
// destroyed units are gone forever, so the form asks for an explicit typed
// confirmation on top of the red warning — never a plain button.
export function PortfolioUiBurn({
  account,
  amount,
  isLoading,
  pricePerUnitEur,
  symbol,
  confirm,
}: {
  account: Address
  amount: string
  isLoading: boolean
  pricePerUnitEur: null | number
  symbol: null | string
  confirm: (input: { account: Address; amount: string }) => Promise<void>
}) {
  const { t } = useTranslation('portfolio')
  const pricing = usePortfolioPricing()
  const availableAmount = Number(amount)
  const hasBurnableAmount = availableAmount > 0
  // Typed confirmation word: the token symbol when known, else the literal
  // word the label tells the user to type.
  const confirmText = symbol ?? 'BURN'
  const formSchema = z.object({
    account: solanaAddressSchema,
    amount: z
      .number()
      .positive({ message: t(($) => $.burnAmountPositive) })
      .max(availableAmount, { message: t(($) => $.burnAmountMax, { amount }) }),
    confirmation: z
      .string()
      .refine((value) => value === confirmText, { message: t(($) => $.burnConfirmError, { symbol: confirmText }) }),
  })

  type PortfolioUiBurnInput = z.infer<typeof formSchema>
  const form = useForm({
    defaultValues: {
      account,
      amount: Number(amount),
      confirmation: '',
    },
    mode: 'onChange',
    resolver: zodResolver(formSchema),
  })
  const accountId = useId()
  const amountId = useId()
  const confirmationId = useId()
  useEffect(() => {
    form.reset({
      account,
      amount: Number(amount),
      confirmation: '',
    })
  }, [account, amount, form])
  async function handleSubmit(data: PortfolioUiBurnInput) {
    await confirm({ account: data.account, amount: data.amount.toString() })
  }

  const typedAmount = form.watch('amount')
  const destroyedValue = pricePerUnitEur !== null && Number.isFinite(typedAmount) ? typedAmount * pricePerUnitEur : null

  return (
    <div className="space-y-6">
      <Alert variant="destructive">
        <UiIcon className="size-4" icon="alert" />
        <AlertTitle>{t(($) => $.burnWarningTitle)}</AlertTitle>
        <AlertDescription>
          <p>{t(($) => $.burnWarningDescription)}</p>
          {destroyedValue !== null ? (
            <p className="mt-1 font-semibold">
              {t(($) => $.burnEstimatedValue, { value: pricing.format(destroyedValue) })}
            </p>
          ) : null}
        </AlertDescription>
      </Alert>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(handleSubmit)}>
          <FieldGroup>
            <FieldSet>
              <FieldGroup>
                <FormField
                  control={form.control}
                  name="account"
                  render={({ field }) => (
                    <FormItem>
                      <Field>
                        <FieldLabel htmlFor={accountId}>{t(($) => $.sendInputAccountLabel)}</FieldLabel>
                        <Input {...field} autoComplete="off" autoFocus disabled id={accountId} readOnly type="text" />
                      </Field>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="amount"
                  render={({ field }) => (
                    <FormItem>
                      <Field>
                        <FieldLabel htmlFor={amountId}>{t(($) => $.sendInputAmountLabel)}</FieldLabel>
                        <Input
                          {...field}
                          autoComplete="off"
                          className="w-[200px]"
                          id={amountId}
                          max={amount}
                          min="0"
                          onChange={(e) => field.onChange(e.target.valueAsNumber)}
                          placeholder={t(($) => $.sendInputAmountPlaceholder)}
                          step="any"
                          type="number"
                        />
                      </Field>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="confirmation"
                  render={({ field }) => (
                    <FormItem>
                      <Field>
                        <FieldLabel htmlFor={confirmationId}>
                          {t(($) => $.burnConfirmLabel, { symbol: confirmText })}
                        </FieldLabel>
                        <Input
                          {...field}
                          autoComplete="off"
                          className="w-[200px] border-destructive"
                          data-confirm-value={confirmText}
                          id={confirmationId}
                          type="text"
                        />
                      </Field>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </FieldGroup>
            </FieldSet>
            {hasBurnableAmount ? null : (
              <Alert variant="warning">
                <UiIcon className="size-4" icon="alert" />
                <AlertTitle>{t(($) => $.burnNoBalanceTitle)}</AlertTitle>
                <AlertDescription>{t(($) => $.burnNoBalanceDescription)}</AlertDescription>
              </Alert>
            )}
            <Field className="flex justify-end" orientation="horizontal">
              <Button
                disabled={isLoading || !hasBurnableAmount || !form.formState.isValid}
                type="submit"
                variant="destructive"
              >
                {isLoading ? <UiLoader className="size-4" /> : null}
                {t(($) => $.actionBurn)}
              </Button>
            </Field>
          </FieldGroup>
        </form>
      </Form>
    </div>
  )
}
