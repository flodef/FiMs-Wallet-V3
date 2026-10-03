import { standardSchemaResolver } from '@hookform/resolvers/standard-schema'
import { useTranslation } from '@workspace/i18n'
import type { MnemonicStrength } from '@workspace/keypair/generate-mnemonic'
import { generateMnemonic } from '@workspace/keypair/generate-mnemonic'
import type { MnemonicLanguage } from '@workspace/keypair/get-mnemonic-wordlist'
import { mnemonicLanguageFromAppLanguage } from '@workspace/keypair/get-mnemonic-wordlist'
import { validateMnemonic } from '@workspace/keypair/validate-mnemonic'
import { Button } from '@workspace/ui/components/button'
import { Form } from '@workspace/ui/components/form'
import { UiBackButton } from '@workspace/ui/components/ui-back-button'
import { UiCard } from '@workspace/ui/components/ui-card'
import { UiIcon } from '@workspace/ui/components/ui-icon'
import { UiTextCopyButton } from '@workspace/ui/components/ui-text-copy-button'
import { toastError } from '@workspace/ui/lib/toast-error'
import { useConcealOnBlur } from '@workspace/ui/lib/use-conceal-on-blur'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useNavigate } from 'react-router'
import { z } from 'zod'
import {
  type CreateNewWalletProtectionMode,
  getCreateNewWalletProtection,
  parseCreateNewWalletProtectionMode,
  useCreateNewWallet,
} from './data-access/use-create-new-wallet.tsx'
import { OnboardingUiMnemonicSave } from './ui/onboarding-ui-mnemonic-save.tsx'
import { OnboardingUiMnemonicSelectLanguage } from './ui/onboarding-ui-mnemonic-select-language.tsx'
import { OnboardingUiMnemonicSelectStrength } from './ui/onboarding-ui-mnemonic-select-strength.tsx'
import { OnboardingUiMnemonicShow } from './ui/onboarding-ui-mnemonic-show.tsx'
import { OnboardingUiWalletProtection } from './ui/onboarding-ui-wallet-protection.tsx'

const onboardingGenerateSchema = z.object({
  language: z.enum(['en', 'fr', 'es']),
  mnemonic: z.string(),
  strength: z.union([z.literal(128), z.literal(256)]),
})

type OnboardingGenerateForm = z.infer<typeof onboardingGenerateSchema>

export function OnboardingFeatureGenerate({ redirectTo }: { redirectTo: string }) {
  const { i18n, t } = useTranslation('onboarding')
  const defaultLanguage: MnemonicLanguage = mnemonicLanguageFromAppLanguage(i18n.language)
  const create = useCreateNewWallet()
  const navigate = useNavigate()
  const [pin, setPin] = useState('')
  const [pinConfirm, setPinConfirm] = useState('')
  const [protectionMode, setProtectionMode] = useState<CreateNewWalletProtectionMode>('password')
  const [revealed, setRevealed] = useState<boolean>(false)
  useConcealOnBlur(revealed, () => setRevealed(false))
  const [unsecuredConfirmed, setUnsecuredConfirmed] = useState(false)

  const form = useForm<OnboardingGenerateForm>({
    defaultValues: {
      language: defaultLanguage,
      mnemonic: generateMnemonic({ language: defaultLanguage, strength: 128 }),
      strength: 128,
    },
    resolver: standardSchemaResolver(onboardingGenerateSchema),
  })
  const { handleSubmit, setValue, watch } = form

  const language = watch('language')
  const strength = watch('strength')
  const mnemonic = watch('mnemonic')

  async function submit(input: OnboardingGenerateForm) {
    try {
      const created = await create(
        input.mnemonic,
        getCreateNewWalletProtection({
          pin,
          pinConfirm,
          protectionMode,
          unsecuredConfirmed,
        }),
      )
      if (created) {
        await navigate(redirectTo)
      }
    } catch (error) {
      toastError(`${error}`)
    }
  }

  function handleProtectionModeChange(value: string) {
    if (!value) {
      return
    }
    setPin('')
    setPinConfirm('')
    setProtectionMode(parseCreateNewWalletProtectionMode(value))
    setUnsecuredConfirmed(false)
  }

  return (
    <Form {...form}>
      <form onSubmit={handleSubmit(submit)}>
        <UiCard
          description={t(($) => $.generateCardDescription)}
          footer={
            <div className="flex w-full justify-between">
              <UiTextCopyButton
                label={t(($) => $.generateToastCopy)}
                text={mnemonic}
                toast={t(($) => $.generateToastCopied)}
              />
              <OnboardingUiMnemonicSave
                disabled={!validateMnemonic({ mnemonic })}
                label={t(($) => $.generateButtonCreate)}
              />
            </div>
          }
          title={
            <div>
              <UiBackButton className="mr-2" />
              {t(($) => $.generateCardTitle)}
            </div>
          }
        >
          <div className="space-y-6">
            <div className="flex justify-between">
              <div className="space-y-2">
                <OnboardingUiMnemonicSelectLanguage
                  language={language}
                  setLanguage={(newLanguage: MnemonicLanguage) => {
                    setValue('language', newLanguage)
                    setValue('mnemonic', generateMnemonic({ language: newLanguage, strength }))
                  }}
                />
                <OnboardingUiMnemonicSelectStrength
                  setStrength={(newStrength: MnemonicStrength) => {
                    setValue('strength', newStrength)
                    setValue('mnemonic', generateMnemonic({ language, strength: newStrength }))
                  }}
                  strength={strength}
                />
              </div>
              <Button onClick={() => setRevealed((value) => !value)} type="button" variant="secondary">
                <UiIcon icon="watch" />
                {revealed ? t(($) => $.generateMnemonicHide) : t(($) => $.generateMnemonicShow)}
              </Button>
            </div>
            <OnboardingUiMnemonicShow mnemonic={mnemonic} revealed={revealed} />
            <OnboardingUiWalletProtection
              onPinChange={setPin}
              onPinConfirmChange={setPinConfirm}
              onProtectionModeChange={handleProtectionModeChange}
              onUnsecuredConfirmedChange={setUnsecuredConfirmed}
              pin={pin}
              pinConfirm={pinConfirm}
              protectionMode={protectionMode}
              unsecuredConfirmed={unsecuredConfirmed}
            />
          </div>
        </UiCard>
      </form>
    </Form>
  )
}
