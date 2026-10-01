// FiMs treasury wallet — public, safe to embed in the bundle.
export const FIMS_TREASURY_ADDRESS = '58kZBjjtHShTtXFmygr3ZT8VSU4dH28PanRAdouHbToh'

// Public portfolio/audit view of the treasury on Jupiter.
export const FIMS_AUDIT_URL = `https://jup.ag/portfolio/${FIMS_TREASURY_ADDRESS}`

// The .sol domain expected to resolve to the treasury address. Only displayed
// next to the audit link when the on-chain record actually points there.
export const FIMS_TREASURY_DOMAIN = 'fimsfi.sol' as const
