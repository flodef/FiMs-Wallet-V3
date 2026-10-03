// Address-poisoning defense: dust attackers craft vanity addresses that share
// the first/last characters of an address the victim knows, hoping the victim
// copies it from transaction history. This flags destinations that are not an
// exact match but are suspiciously similar to a known address.

const EDGE_MATCH_LENGTH = 4

export function findLookalikeAddress({
  destination,
  knownAddresses,
}: {
  destination: string
  knownAddresses: string[]
}): string | null {
  if (!destination || destination.length <= EDGE_MATCH_LENGTH * 2) {
    return null
  }
  const head = destination.slice(0, EDGE_MATCH_LENGTH)
  const tail = destination.slice(-EDGE_MATCH_LENGTH)
  for (const known of knownAddresses) {
    if (!known || known === destination || known.length <= EDGE_MATCH_LENGTH * 2) {
      continue
    }
    if (known.startsWith(head) && known.endsWith(tail)) {
      return known
    }
  }
  return null
}
