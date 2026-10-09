// Shared FiMs addresses — single source for the API side. The client copies
// live in packages/feature-fims/src/fims-constants.ts (the API stays
// dependency-free for its standalone Vercel bundle, so these strings are
// duplicated across the boundary on purpose).
export const FIMS_TONTINE_ADDRESS = 'Fe1RpesrtYMJdjwbNXtpVCDNpnFvk6jSic3sJd2aCBng'
export const FIMS_TREASURY_ADDRESS = '58kZBjjtHShTtXFmygr3ZT8VSU4dH28PanRAdouHbToh'
export const FIMS_DEMO_ADDRESS = '5F86TNSTre3CYwZd1wELsGQGhqG2HkN3d8zxhbyBSnzm'
