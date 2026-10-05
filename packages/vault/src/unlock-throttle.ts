// Progressive delay between failed credential-unlock attempts. Throttling
// PIN/password retries in the UI raises the cost of casual brute force —
// it is defense-in-depth, not a cryptographic boundary: an attacker who
// can dump and edit localStorage resets the counter, so PBKDF2 still
// carries the real load.
const STORAGE_KEY = 'vault:unlock-throttle'
const FREE_ATTEMPTS = 3
const BASE_DELAY_MS = 15_000
const MAX_DELAY_MS = 5 * 60_000

interface ThrottleEntry {
  attempts: number
  nextAllowedAt: number
}

// MV3 service workers and the node test runner have no localStorage, so
// state falls back to a module-level Map — still better than nothing.
const memoryEntries = new Map<string, string>()

function storage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  try {
    if (typeof localStorage !== 'undefined') {
      return localStorage
    }
  } catch {}
  return {
    getItem: (key) => memoryEntries.get(key) ?? null,
    removeItem: (key) => void memoryEntries.delete(key),
    setItem: (key, value) => void memoryEntries.set(key, value),
  }
}

function readEntries(): Record<string, ThrottleEntry> {
  const raw = storage().getItem(STORAGE_KEY)
  if (!raw) {
    return {}
  }
  try {
    return JSON.parse(raw) as Record<string, ThrottleEntry>
  } catch {
    return {}
  }
}

function writeEntries(entries: Record<string, ThrottleEntry>): void {
  storage().setItem(STORAGE_KEY, JSON.stringify(entries))
}

// Throws when the target must wait before another unlock attempt.
export function checkUnlockThrottle(target: string): void {
  const entry = readEntries()[target]
  if (!entry || entry.attempts < FREE_ATTEMPTS) {
    return
  }
  const remaining = entry.nextAllowedAt - Date.now()
  if (remaining > 0) {
    throw new Error(`Too many failed attempts — try again in ${Math.ceil(remaining / 1000)}s`)
  }
}

export function recordUnlockFailure(target: string): void {
  const entries = readEntries()
  const attempts = (entries[target]?.attempts ?? 0) + 1
  const delay = Math.min(BASE_DELAY_MS * 2 ** Math.max(0, attempts - FREE_ATTEMPTS), MAX_DELAY_MS)
  entries[target] = { attempts, nextAllowedAt: attempts < FREE_ATTEMPTS ? 0 : Date.now() + delay }
  writeEntries(entries)
}

export function clearUnlockThrottle(target: string): void {
  const entries = readEntries()
  if (entries[target]) {
    delete entries[target]
    writeEntries(entries)
  }
}

export function resetUnlockThrottle(): void {
  memoryEntries.clear()
  storage().removeItem(STORAGE_KEY)
}
