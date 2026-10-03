import { z } from 'zod'

export const settingKeySchema = z.enum([
  'activeAccountId',
  'activeNetworkId',
  'apiEndpoint',
  'fimsCurrency',
  'fimsLastSeenTransaction',
  'language',
  'sendCapEur',
  'theme',
  'themeWallpaper',
  'vaultKey',
  'vaultPasskey',
  'vaultTotp',
  'withdrawExchangeAddress',
  'withdrawExchangeProvider',
  'withdrawJupiterSpend',
])
