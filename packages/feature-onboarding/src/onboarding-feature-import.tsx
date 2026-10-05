import { standardSchemaResolver } from '@hookform/resolvers/standard-schema'
import { useWalletGenerateWithAccount } from '@workspace/db-react/use-wallet-generate-with-account'
import { useTranslation } from '@workspace/i18n'
import { derivationPaths } from '@workspace/keypair/derivation-paths'
import type { MnemonicStrength } from '@workspace/keypair/generate-mnemonic'
import { getMnemonicWordStatus } from '@workspace/keypair/get-mnemonic-word-status'
import { validateMnemonic } from '@workspace/keypair/validate-mnemonic'
import { Button } from '@workspace/ui/components/button'
import { Form } from '@workspace/ui/components/form'
import { Input } from '@workspace/ui/components/input'
import { Label } from '@workspace/ui/components/label'
import { Textarea } from '@workspace/ui/components/textarea'
import { ToggleGroup, ToggleGroupItem } from '@workspace/ui/components/toggle-group'
import { UiBackButton } from '@workspace/ui/components/ui-back-button'
import { UiCard } from '@workspace/ui/components/ui-card'
import { UiQrRegionScan } from '@workspace/ui/components/ui-qr-region-scan'
import { UiTextPasteButton } from '@workspace/ui/components/ui-text-paste-button'
import { toastError } from '@workspace/ui/lib/toast-error'
import { VAULT_UNSECURED_CONFIRM_PHRASE } from '@workspace/vault/encrypted-value-schema'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useNavigate } from 'react-router'
import { z } from 'zod'
import {
  type CreateNewWalletProtectionMode,
  getCreateNewWalletProtection,
  parseCreateNewWalletProtectionMode,
  useCreateNewWallet,
  useCreateNewWalletFromPrivateKey,
  useImportWalletTransfer,
} from './data-access/use-create-new-wallet.tsx'
import { DEMO_MNEMONIC, demoSetState, useDemoState } from './demo/demo-store.tsx'
import { OnboardingUiMnemonicWordInput } from './onboarding-ui-mnemonic-word-input.tsx'
import { OnboardingUiMnemonicSave } from './ui/onboarding-ui-mnemonic-save.tsx'
import { OnboardingUiMnemonicSelectStrength } from './ui/onboarding-ui-mnemonic-select-strength.tsx'
import { OnboardingUiQrScanner } from './ui/onboarding-ui-qr-scanner.tsx'
import { OnboardingUiWalletProtection } from './ui/onboarding-ui-wallet-protection.tsx'

const onboardingImportSchema = z.object({
  strength: z.union([z.literal(128), z.literal(256)]),
  words: z.array(z.string()),
})

type OnboardingImportForm = z.infer<typeof onboardingImportSchema>

export function OnboardingFeatureImport({ redirectTo }: { redirectTo: string }) {
  const { t } = useTranslation('onboarding')
  const create = useCreateNewWallet()
  const generate = useWalletGenerateWithAccount()
  const navigate = useNavigate()
  const demo = useDemoState()
  const [pin, setPin] = useState('')
  const [pinConfirm, setPinConfirm] = useState('')
  const [protectionMode, setProtectionMode] = useState<CreateNewWalletProtectionMode>('password')
  const [unsecuredConfirmText, setUnsecuredConfirmText] = useState('')
  const [importMode, setImportMode] = useState<'mnemonic' | 'privateKey' | 'transfer'>('mnemonic')
  const [privateKey, setPrivateKey] = useState('')
  const [transferCode, setTransferCode] = useState('')
  const [transferScan, setTransferScan] = useState(false)
  const [transferRegion, setTransferRegion] = useState(false)
  const canRegionScan =
    typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function'
  const createPrivateKey = useCreateNewWalletFromPrivateKey()
  const importTransfer = useImportWalletTransfer()
  const privateKeyId = useId()
  const transferCodeId = useId()

  const form = useForm<OnboardingImportForm>({
    defaultValues: {
      strength: 128,
      words: Array(24).fill(''),
    },
    resolver: standardSchemaResolver(onboardingImportSchema),
  })

  const { getValues, handleSubmit, reset, setValue, setError, watch } = form

  const strength = watch('strength')
  const words = watch('words')
  const wordCount = strength === 128 ? 12 : 24

  function handleWordChange(index: number, value: string) {
    // Only allow alphabetic characters and trim whitespace
    const currentWords = getValues('words')
    const newWords = [...currentWords]
    newWords[index] = value.toLowerCase().replace(/[^a-z]/g, '')
    setValue('words', newWords)
  }

  function handlePaste(pasteData: string, startIndex: number = 0) {
    const pastedWords = pasteData.split(/\s+/).filter((word) => word.length > 0)
    const mnemonicStrength = getMnemonicStrength(pastedWords.length)

    if (mnemonicStrength !== false) {
      setValue('strength', mnemonicStrength)
      const newWords = Array(24).fill('')

      pastedWords.forEach((word, i) => {
        if (i < 24) {
          newWords[i] = word.replace(/[^a-z]/g, '')
        }
      })
      setValue('words', newWords)
    } else {
      const currentWords = getValues('words')
      const newWords = [...currentWords]

      pastedWords.forEach((word, i) => {
        const targetIndex = startIndex + i
        if (targetIndex < currentWords.length) {
          newWords[targetIndex] = word.replace(/[^a-z]/g, '')
        }
      })
      setValue('words', newWords)
    }
  }

  function handleProtectionModeChange(value: string) {
    if (!value) {
      return
    }
    setPin('')
    setPinConfirm('')
    setProtectionMode(parseCreateNewWalletProtectionMode(value))
    setUnsecuredConfirmText('')
  }

  const isFormComplete = useMemo(() => {
    return words.slice(0, wordCount).every((word) => getMnemonicWordStatus(word) === 'valid')
  }, [words, wordCount])

  async function submit() {
    if (importMode === 'mnemonic' && !isFormComplete) {
      setError('words', { message: `Please enter all ${wordCount} words.` })
      return
    }

    try {
      const protection = getCreateNewWalletProtection({
        pin,
        pinConfirm,
        protectionMode,
        unsecuredConfirmText,
      })
      const created =
        importMode === 'privateKey'
          ? await createPrivateKey(privateKey, protection)
          : importMode === 'transfer'
            ? await importTransfer(transferCode, protection)
            : await create(validateMnemonic({ mnemonic: words.slice(0, wordCount).join(' ') }), protection)
      if (created) {
        await navigate(redirectTo)
      }
    } catch (error) {
      toastError(`${error}`)
    }
  }

  const demoActionRef = useRef({ generate, navigate, redirectTo })
  useEffect(() => {
    demoActionRef.current = { generate, navigate, redirectTo }
  })

  useEffect(() => {
    if (!demo.active || demo.walletCreated) {
      return
    }
    setProtectionMode('unsecured')
    setUnsecuredConfirmText(VAULT_UNSECURED_CONFIRM_PHRASE)
    const demoWords = DEMO_MNEMONIC.split(' ')
    let index = 0
    let timeout: ReturnType<typeof setTimeout> | undefined
    const interval = setInterval(() => {
      const word = demoWords[index]
      if (!word) {
        return
      }
      const newWords = [...getValues('words')]
      newWords[index] = word
      setValue('words', newWords)
      index++
      if (index >= demoWords.length) {
        clearInterval(interval)
        timeout = setTimeout(() => {
          const { generate: gen, navigate: nav, redirectTo: to } = demoActionRef.current
          gen
            .mutateAsync({
              derivationPath: derivationPaths.default,
              mnemonic: DEMO_MNEMONIC,
              name: 'Démo',
              protection: { mode: 'unsecured' },
            })
            .then(async () => {
              demoSetState({ stepIndex: 1, walletCreated: true })
              await nav(to)
            })
            .catch((error: unknown) => toastError(`${error}`))
        }, 800)
      }
    }, 150)
    return () => {
      clearInterval(interval)
      clearTimeout(timeout)
    }
  }, [demo.active, demo.walletCreated, getValues, setValue])

  return (
    <Form {...form}>
      <form onSubmit={handleSubmit(submit)}>
        <UiCard
          description={t(($) => $.importCardDescription)}
          footer={
            <div className="flex w-full justify-between">
              <UiTextPasteButton
                label={t(($) => $.importToastPaste)}
                onPaste={
                  importMode === 'privateKey'
                    ? (data) => setPrivateKey(data.trim())
                    : importMode === 'transfer'
                      ? (data) => setTransferCode(data.trim())
                      : handlePaste
                }
              />
              <OnboardingUiMnemonicSave
                disabled={
                  importMode === 'privateKey'
                    ? !privateKey.trim().length
                    : importMode === 'transfer'
                      ? !transferCode.trim().length
                      : !isFormComplete
                }
                label={t(($) => $.importButtonSubmit)}
              />
            </div>
          }
          title={
            <div>
              <UiBackButton className="mr-2" />
              {t(($) => $.importCardTitle)}
            </div>
          }
        >
          <div className="space-y-6">
            <ToggleGroup
              className="grid w-full grid-cols-3"
              onValueChange={(value) => value && setImportMode(value as 'mnemonic' | 'privateKey' | 'transfer')}
              type="single"
              value={importMode}
              variant="outline"
            >
              <ToggleGroupItem
                className="h-auto min-h-9 whitespace-normal px-3 py-2 text-center leading-snug"
                value="mnemonic"
              >
                {t(($) => $.importModeMnemonic)}
              </ToggleGroupItem>
              <ToggleGroupItem
                className="h-auto min-h-9 whitespace-normal px-3 py-2 text-center leading-snug"
                value="privateKey"
              >
                {t(($) => $.importModePrivateKey)}
              </ToggleGroupItem>
              <ToggleGroupItem
                className="h-auto min-h-9 whitespace-normal px-3 py-2 text-center leading-snug"
                value="transfer"
              >
                {t(($) => $.importModeTransfer)}
              </ToggleGroupItem>
            </ToggleGroup>

            {importMode === 'transfer' ? (
              <div className="space-y-3">
                <div className="space-y-2">
                  <Label htmlFor={transferCodeId}>{t(($) => $.importTransferLabel)}</Label>
                  <Textarea
                    autoComplete="off"
                    id={transferCodeId}
                    onChange={(event) => setTransferCode(event.target.value)}
                    placeholder={t(($) => $.importTransferPlaceholder)}
                    value={transferCode}
                  />
                  <p className="text-muted-foreground text-xs">{t(($) => $.importTransferHint)}</p>
                </div>
                <Button
                  className="w-full"
                  onClick={() => setTransferScan((value) => !value)}
                  type="button"
                  variant="outline"
                >
                  {transferScan ? t(($) => $.importTransferScanHide) : t(($) => $.importTransferScanShow)}
                </Button>
                {transferScan ? (
                  <OnboardingUiQrScanner
                    onScan={(value) => {
                      setTransferCode(value)
                      setTransferScan(false)
                    }}
                  />
                ) : null}
                {canRegionScan ? (
                  <Button
                    className="w-full"
                    onClick={() => setTransferRegion((value) => !value)}
                    type="button"
                    variant="outline"
                  >
                    {transferRegion ? t(($) => $.importTransferRegionHide) : t(($) => $.importTransferRegionShow)}
                  </Button>
                ) : null}
                {transferRegion ? (
                  <UiQrRegionScan
                    noCodeMessage={t(($) => $.importTransferRegionNoCode)}
                    onScan={(value) => {
                      setTransferCode(value)
                      setTransferRegion(false)
                    }}
                    reshareLabel={t(($) => $.importTransferRegionReshare)}
                  />
                ) : null}
              </div>
            ) : importMode === 'privateKey' ? (
              <div className="space-y-2">
                <Label htmlFor={privateKeyId}>{t(($) => $.importPrivateKeyLabel)}</Label>
                <Input
                  autoComplete="off"
                  id={privateKeyId}
                  onChange={(event) => setPrivateKey(event.target.value)}
                  placeholder={t(($) => $.importPrivateKeyPlaceholder)}
                  type="password"
                  value={privateKey}
                />
              </div>
            ) : (
              <>
                <div className="flex justify-between">
                  <div>
                    <OnboardingUiMnemonicSelectStrength
                      setStrength={(newStrength: MnemonicStrength) => {
                        reset({
                          strength: newStrength,
                          words: Array(24).fill(''),
                        })
                      }}
                      strength={strength}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3">
                  {Array.from({ length: wordCount }, (_, i) => i).map((index) => (
                    <OnboardingUiMnemonicWordInput
                      index={index + 1}
                      key={index}
                      onChange={handleWordChange}
                      onPaste={(dataTransfer) => {
                        const text = dataTransfer.getData('text').trim().toLowerCase()
                        if (text.length) {
                          handlePaste(text)
                        }
                      }}
                      value={words[index] || ''}
                    />
                  ))}
                </div>

                {form.formState.errors.words ? (
                  <p className="mt-4 text-center text-red-500 text-sm">{form.formState.errors.words.message}</p>
                ) : null}
              </>
            )}

            <OnboardingUiWalletProtection
              onPinChange={setPin}
              onPinConfirmChange={setPinConfirm}
              onProtectionModeChange={handleProtectionModeChange}
              onUnsecuredConfirmTextChange={setUnsecuredConfirmText}
              pin={pin}
              pinConfirm={pinConfirm}
              protectionMode={protectionMode}
              unsecuredConfirmText={unsecuredConfirmText}
            />
          </div>
        </UiCard>
      </form>
    </Form>
  )
}

function getMnemonicStrength(len: number): false | MnemonicStrength {
  if (len === 12) {
    return 128
  }
  if (len === 24) {
    return 256
  }
  return false
}
