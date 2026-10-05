import { setEnv } from '@workspace/env/env'

const env = {
  activeNetworkId: import.meta.env['VITE_ACTIVE_NETWORK_ID'],
  adminAddresses: import.meta.env['VITE_ADMIN_ADDRESSES'],
  allowUnsecuredWallets: import.meta.env['VITE_ALLOW_UNSECURED_WALLETS'],
  // Same-origin by default: on Vercel the API lives under /api on the wallet
  // domain. VITE_API_ENDPOINT still wins (e.g. local wrangler dev on :8787).
  apiEndpoint: import.meta.env['VITE_API_ENDPOINT'] || `${window.location.origin}/api`,
  networkDevnet: import.meta.env['VITE_NETWORK_DEVNET'],
  networkDevnetSubscriptions: import.meta.env['VITE_NETWORK_DEVNET_SUBSCRIPTIONS'],
  networkLocalnet: import.meta.env['VITE_NETWORK_LOCALNET'],
  networkLocalnetSubscriptions: import.meta.env['VITE_NETWORK_LOCALNET_SUBSCRIPTIONS'],
  networkMainnet: import.meta.env['VITE_NETWORK_MAINNET'],
  networkMainnetSubscriptions: import.meta.env['VITE_NETWORK_MAINNET_SUBSCRIPTIONS'],
  networkTestnet: import.meta.env['VITE_NETWORK_TESTNET'],
  networkTestnetSubscriptions: import.meta.env['VITE_NETWORK_TESTNET_SUBSCRIPTIONS'],
}

setEnv(Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)))
