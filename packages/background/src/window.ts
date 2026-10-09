import { defineCustomEventMessaging } from '@webext-core/messaging/page'

import type { PageSchema } from './window-schema.ts'

export const { onMessage, sendMessage } = defineCustomEventMessaging<PageSchema>({
  namespace: 'fims-wallet',
})
