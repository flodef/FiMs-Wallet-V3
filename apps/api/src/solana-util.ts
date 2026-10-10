// Shared Solana RPC helpers — public RPCs rate-limit hard, so every call
// retries transient 429s instead of failing a keeper/mint pass on a blip.
import type { Address, createSolanaRpc } from '@solana/kit'

const DEFAULT_RPC_URL = 'https://api.mainnet-beta.solana.com'
export const rpcUrl = () => process.env['SOLANA_RPC_URL'] ?? DEFAULT_RPC_URL

export async function rpcCall<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (error) {
      if (i > 8 || !`${error}`.includes('429')) throw error
      await new Promise((resolve) => setTimeout(resolve, 1500))
    }
  }
}

export async function tokenBalance(rpc: ReturnType<typeof createSolanaRpc>, tokenAccount: Address): Promise<bigint> {
  const res = await rpcCall(() => rpc.getTokenAccountBalance(tokenAccount).send())
  return BigInt(res.value.amount)
}

// Yield/swap providers (Jupiter, Kamino) all answer "return raw instructions"
// APIs — one fetch with retries on 429/5xx and the {instructions} unwrapping
// shared between the custodial yield path and the strategy keeper.
export async function fetchProviderInstructions(url: string, payload: Record<string, unknown>): Promise<unknown[]> {
  let lastError: unknown = new Error('provider API unreachable')
  for (let attempt = 0; attempt < 4; attempt++) {
    let response: Response
    try {
      response = await fetch(url, {
        body: JSON.stringify(payload),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)))
      continue
    }
    if (response.ok) {
      const body = (await response.json()) as unknown[] | { instructions?: unknown[] }
      if (Array.isArray(body)) return body
      if (Array.isArray(body.instructions)) return body.instructions
      throw new Error('provider API returned no instructions')
    }
    lastError = new Error(`provider API ${response.status}: ${(await response.text()).slice(0, 200)}`)
    if (response.status !== 429 && response.status < 500) throw lastError
    await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)))
  }
  throw lastError
}

// Raw base units → exact decimal string (bigint-safe, no float path). Used
// for ledger writes where a `numeric` column must hold the precise on-chain
// quantity — `Number(raw) / 10**decimals` loses digits past 15.
export function formatTokenUnits(raw: bigint, decimals: number): string {
  const negative = raw < 0n
  const digits = (negative ? -raw : raw).toString().padStart(decimals + 1, '0')
  // slice(0, -0) is slice(0, 0) — decimals = 0 needs the whole string, not
  // '' → '0'.
  const whole = decimals ? digits.slice(0, -decimals) || '0' : digits
  const frac = decimals ? digits.slice(-decimals).replace(/0+$/, '') : ''
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`
}
