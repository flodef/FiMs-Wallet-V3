// RFC 6238 TOTP (HMAC-SHA1, 30s step, 6 digits) implemented on WebCrypto —
// no dependency needed for one HMAC per verify.
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const TOTP_DIGITS = 6
const TOTP_STEP_SECONDS = 30

export function generateTotpSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20))
  let output = ''
  let buffer = 0
  let bits = 0
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(buffer << (5 - bits)) & 31]
  }
  return output
}

export function totpUri({ account, issuer, secret }: { account: string; issuer: string; secret: string }): string {
  const params = new URLSearchParams({ issuer, secret })
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?${params}`
}

export async function totp({
  secret,
  timestamp = Date.now(),
}: {
  secret: string
  timestamp?: number
}): Promise<string> {
  const counter = Math.floor(timestamp / 1000 / TOTP_STEP_SECONDS)
  const counterBytes = new Uint8Array(8)
  new DataView(counterBytes.buffer).setUint32(4, counter)
  const key = await crypto.subtle.importKey(
    'raw',
    base32Decode(secret) as Uint8Array<ArrayBuffer>,
    { hash: 'SHA-1', name: 'HMAC' },
    false,
    ['sign'],
  )
  const hmac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counterBytes))
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f
  const code =
    ((((hmac[offset] ?? 0) & 0x7f) << 24) |
      ((hmac[offset + 1] ?? 0) << 16) |
      ((hmac[offset + 2] ?? 0) << 8) |
      (hmac[offset + 3] ?? 0)) %
    10 ** TOTP_DIGITS
  return String(code).padStart(TOTP_DIGITS, '0')
}

export async function verifyTotp({
  code,
  secret,
  timestamp = Date.now(),
  window = 1,
}: {
  code: string
  secret: string
  timestamp?: number
  window?: number
}): Promise<boolean> {
  const normalized = code.replace(/\s/g, '')
  if (!/^\d{6}$/.test(normalized)) {
    return false
  }
  for (let step = -window; step <= window; step++) {
    const candidate = await totp({ secret, timestamp: timestamp + step * TOTP_STEP_SECONDS * 1000 })
    if (candidate === normalized) {
      return true
    }
  }
  return false
}

function base32Decode(secret: string): Uint8Array {
  const cleaned = secret.toUpperCase().replace(/[^A-Z2-7]/g, '')
  let buffer = 0
  let bits = 0
  const bytes: number[] = []
  for (const char of cleaned) {
    buffer = (buffer << 5) | BASE32_ALPHABET.indexOf(char)
    bits += 5
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return new Uint8Array(bytes)
}
