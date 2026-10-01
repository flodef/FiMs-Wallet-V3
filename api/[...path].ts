// Vercel Function: serves the FiMs API (apps/api) under /api/*.
// vercel.json rewrites /api/:path* here (catch-all api routes are not
// supported outside Next.js); the real path arrives in the `...path`
// query param. Host header and raw body are forwarded untouched: the
// wallet signature covers both (see verifyWalletRequest).
import type { IncomingMessage, ServerResponse } from 'node:http'

import app from '../apps/api/src/index.js'

interface VercelRequest extends IncomingMessage {
  body?: unknown
}

async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  // Vercel parses JSON bodies into req.body when possible; re-serializing
  // keeps key order so the SHA-256 body hash still matches the signed body.
  if (req.method === 'GET' || req.method === 'HEAD') return undefined
  const parsed = (req as VercelRequest).body
  if (parsed !== undefined) {
    if (Buffer.isBuffer(parsed)) return parsed
    return Buffer.from(typeof parsed === 'string' ? parsed : JSON.stringify(parsed))
  }
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return chunks.length ? Buffer.concat(chunks) : undefined
}

export default async function handler(req: VercelRequest, res: ServerResponse): Promise<void> {
  const proto = headerValue(req.headers['x-forwarded-proto']) ?? 'https'
  const host = headerValue(req.headers['x-forwarded-host']) ?? headerValue(req.headers.host) ?? 'localhost'
  const url = new URL(req.url ?? '/', `${proto}://${host}`)

  const path = url.searchParams.get('...path') ?? ''
  url.searchParams.delete('...path')
  url.pathname = `/${path}`

  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    headers.set(name, Array.isArray(value) ? value.join(', ') : value)
  }

  const request = new Request(url, {
    body: await readBody(req),
    headers,
    method: req.method,
  })
  const response = await app.fetch(request, process.env)

  res.statusCode = response.status
  response.headers.forEach((value, name) => {
    res.setHeader(name, value)
  })
  res.end(Buffer.from(await response.arrayBuffer()))
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}
