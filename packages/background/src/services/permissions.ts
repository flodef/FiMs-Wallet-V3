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
//
// Grants expire: an indefinite grant means a site connected once, years ago,
// still has silent signing reach if its front-end is compromised later
// (audit L-6). 90 days balances "connected wallet" UX against staleness.
const STORAGE_KEY = 'fimsConnectedOrigins'
const GRANT_TTL_MS = 90 * 24 * 60 * 60 * 1000

export interface GrantedOrigin {
  address: string
  // Optional: grants persisted before the TTL existed have no timestamp —
  // readers must treat a missing one as already expired.
  connectedAt?: number | undefined
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
// never connected, was disconnected, or the grant expired.
export async function grantedAddress(origin: string): Promise<string | null> {
  const origins = await readOrigins()
  const grant = origins[origin]
  if (!grant) return null
  // Grants written before `connectedAt` existed carry undefined →
  // `Date.now() - undefined` is NaN and never trips the TTL. Treat them as
  // expired immediately: the site must connect again, which also re-stamps
  // the field.
  if (Date.now() - (grant.connectedAt ?? 0) > GRANT_TTL_MS) {
    delete origins[origin]
    await writeOrigins(origins)
    return null
  }
  return grant.address
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
