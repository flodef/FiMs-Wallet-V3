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
  'vaultKey',
  'warningAcceptExperimental',
])
