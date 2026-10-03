// Canonical serialization of a URL query string, signed along with the request
// path. The API runs the identical algorithm server-side (see
// apps/api/src/services/auth/service.ts), so both sides must stay in sync:
// decode each pair, sort by key then value, and re-encode with
// URLSearchParams (form-urlencoded). Sorting makes `?a=1&b=2` and `?b=2&a=1`
// produce the same signed message.
export function canonicalizeQuery(searchParams: URLSearchParams): string {
  const pairs = [...searchParams.entries()]
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1))
  return new URLSearchParams(pairs).toString()
}

// The resource string bound into the wallet signature: path plus its canonical
// query, e.g. `/fims/users?limit=2000&offset=0`. Returns the bare path when
// there is no query, so unsigned-query requests keep their legacy signature.
export function canonicalResource(path: string, searchParams: URLSearchParams): string {
  const query = canonicalizeQuery(searchParams)
  return query ? `${path}?${query}` : path
}
