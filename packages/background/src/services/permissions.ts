import { browser } from '@wxt-dev/browser'

// Per-origin dApp permissions.
//
// Before this store existed, ANY web page could call signMessage /
// signTransaction on the wallet without ever connecting — the request popup
// was the only gate. Now `connect` grants an origin the wallet account it saw,
// and every signing path verifies the grant before doing anything.
//
// Persisted in extension-local storage so grants survive service-worker
// restarts. The grant records WHICH account the site saw: a request asking to
// sign with a different account is rejected.
const STORAGE_KEY = 'fimsConnectedOrigins'

export interface GrantedOrigin {
  address: string
  connectedAt: number
}

type ConnectedOrigins = Record<string, GrantedOrigin>

async function readOrigins(): Promise<ConnectedOrigins> {
  const result = await browser.storage.local.get(STORAGE_KEY)
  return (result[STORAGE_KEY] as ConnectedOrigins | undefined) ?? {}
}

async function writeOrigins(origins: ConnectedOrigins): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEY]: origins })
}

export async function grantOrigin(origin: string, address: string): Promise<void> {
  const origins = await readOrigins()
  origins[origin] = { address, connectedAt: Date.now() }
  await writeOrigins(origins)
}

export async function revokeOrigin(origin: string): Promise<void> {
  const origins = await readOrigins()
  delete origins[origin]
  await writeOrigins(origins)
}

// The account this origin is allowed to see/sign with, or null when the site
// never connected (or was disconnected).
export async function grantedAddress(origin: string): Promise<string | null> {
  return (await readOrigins())[origin]?.address ?? null
}

export async function listGrants(): Promise<ConnectedOrigins> {
  return await readOrigins()
}

// Fail closed: signing paths call this first. `account` is the address the
// dApp asks to sign with — it must be exactly the granted one.
export async function requireGranted(origin: string, account: string): Promise<void> {
  const granted = await grantedAddress(origin)
  if (!granted) {
    throw new Error(`origin is not connected: ${origin}`)
  }
  if (granted !== account) {
    throw new Error(`origin ${origin} is not granted account ${account}`)
  }
}
