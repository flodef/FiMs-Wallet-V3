// cspell:ignore Bjjt
// Recipients the wallet can vouch for: shown by name on the send-confirmation
// screen and dApp signing prompts instead of a raw address, so a member sees
// "FiMs Treasury" rather than 58kZBjjt…. Anything NOT listed here (and not in
// the member's accounts or address book) triggers an unknown-recipient
// warning before signing — the last line of defense against a poisoned QR
// code or a malicious Solana Pay link.
//
// Keep in sync with the same addresses in feature-fims/fims-constants.ts.

// Guided-tour demo wallet — public keys, but members may send it dust.
export const FIMS_DEMO_RECIPIENT = '5F86TNSTre3CYwZd1wELsGQGhqG2HkN3d8zxhbyBSnzm'
// FiMs treasury — operating-fee destination and debt-settlement address.
export const FIMS_TREASURY_RECIPIENT = '58kZBjjtHShTtXFmygr3ZT8VSU4dH28PanRAdouHbToh'
// Tontine wallet — free donations land here.
export const FIMS_TONTINE_RECIPIENT = 'Fe1RpesrtYMJdjwbNXtpVCDNpnFvk6jSic3sJd2aCBng'
