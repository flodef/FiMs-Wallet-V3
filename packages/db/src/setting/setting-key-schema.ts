import { z } from 'zod'

export const settingKeySchema = z.enum([
  'activeAccountId',
  'activeNetworkId',
  'apiEndpoint',
  'fimsLastSeenTransaction',
  'language',
  'theme',
  'vaultKey',
  'warningAcceptExperimental',
])
