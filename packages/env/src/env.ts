import { z } from 'zod'

export const envSchema = z.object({
  activeNetworkId: z
    .enum(['networkDevnet', 'networkLocalnet', 'networkMainnet', 'networkTestnet'])
    .default('networkDevnet'),
  adminAddresses: z.string().default('CCLcWAJX6fubUqGyZWz8dyUGEddRj8h4XZZCNSDzMVx4'),
  // VITE_ALLOW_UNSECURED_WALLETS — dev/test escape hatch: the cleartext
  // storage protection mode must never be offered in production builds.
  allowUnsecuredWallets: z.string().default(''),
  // Same-origin by default: Vercel rewrites /api/* to the api function
  // (api/[...path].ts), so the bundle and the API code always deploy together.
  // The Cloudflare worker remains reachable for other clients.
  apiEndpoint: z.url().default('https://wallet-v3.fims.fi/api'),
  networkDevnet: z.url().or(z.literal('')).default('https://api.devnet.solana.com'),
  networkDevnetSubscriptions: z.url().or(z.literal('')).default(''),
  networkLocalnet: z.url().or(z.literal('')).default('http://localhost:8899'),
  networkLocalnetSubscriptions: z.url().or(z.literal('')).default('ws://127.0.0.1:8900'),
  networkMainnet: z.url().or(z.literal('')).default(''),
  networkMainnetSubscriptions: z.url().or(z.literal('')).default(''),
  networkTestnet: z.url().or(z.literal('')).default('https://api.testnet.solana.com'),
  networkTestnetSubscriptions: z.url().or(z.literal('')).default(''),
})

export type Env = z.infer<typeof envSchema>

let memoizedEnv: Env | undefined

export function env(key: keyof Env): string {
  if (!memoizedEnv) {
    memoizedEnv = envSchema.parse({})
  }
  return memoizedEnv[key]
}

export function envAllowUnsecuredWallets(): boolean {
  return env('allowUnsecuredWallets') === 'true'
}

// Comma-separated public keys (VITE_ADMIN_ADDRESSES). These are not secrets —
// they only gate privileged UI like the apiEndpoint override.
export function envAdminAddresses(): string[] {
  return env('adminAddresses')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

export function setEnv(env: Partial<Env> = {}) {
  memoizedEnv = envSchema.parse(env)
}
