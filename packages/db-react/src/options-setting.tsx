import { type MutateOptions, mutationOptions } from '@tanstack/react-query'
import type { DbContext } from '@workspace/db/db-context'
import type { SettingKey } from '@workspace/db/setting/setting-key'
import { settingSetValue } from '@workspace/db/setting/setting-set-value'
import { i18n } from '@workspace/i18n'
import { toastError } from '@workspace/ui/lib/toast-error'
import { queryClient } from './query-client.tsx'
import { optionsSettingFindMany } from './wallet-graph-queries.ts'

export type SettingSetValueMutateOptions = MutateOptions<void, Error, string>

export const optionsSetting = {
  findMany: optionsSettingFindMany,
  update: (ctx: DbContext, key: SettingKey, props: SettingSetValueMutateOptions = {}) =>
    mutationOptions({
      mutationFn: (value: string) => settingSetValue(ctx, key, value),
      onError: () => toastError(i18n.t(($) => $.toastSettingSaveFailed, { ns: 'ui' })),
      onSuccess: () => {
        queryClient.invalidateQueries(optionsSettingFindMany(ctx, {}))
      },
      ...props,
    }),
}
