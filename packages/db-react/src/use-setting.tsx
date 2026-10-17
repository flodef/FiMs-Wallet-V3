import type { SettingKey } from '@workspace/db/setting/setting-key'
import { useCallback } from 'react'

import { useSettingGetValueLive } from './use-setting-get-value-live.tsx'
import { useSettingSetValue } from './use-setting-set-value.tsx'

export function useSetting(key: SettingKey): [null | string, (newValue: string) => Promise<void>] {
  const getValue = useSettingGetValueLive(key)
  const setValue = useSettingSetValue(key)
  // A fresh lambda per render retriggers every effect that depends on it.
  const set = useCallback((newValue: string) => setValue.mutateAsync(newValue), [setValue.mutateAsync])

  return [getValue, set]
}
