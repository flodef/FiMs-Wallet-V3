# Security Policy

FiMs Wallet is a non-custodial Solana hot wallet for the FiMs community. Private keys
never leave the user's browser: they are stored encrypted in IndexedDB and only exist
in memory while the wallet is unlocked.

## Reporting a Vulnerability

Please report security issues privately through the GitHub Security Advisory
["Report a Vulnerability"](https://github.com/flodef/FiMs-Wallet-V3/security/advisories/new)
tab. Do **not** open a public issue for a vulnerability that could put user funds at
risk. We will acknowledge the report and keep you informed of the progress towards a
fix and public disclosure.

## Cryptography

- Vault encryption: AES-256-GCM (16-byte salt, 12-byte IV, 16-byte auth tag).
- Key derivation: PBKDF2-SHA256 with at least 600,000 iterations.
- Wallet protection modes: `password` (vault-level key), `pin` (per-wallet envelope),
  `unsecured` (no protection — see below).
- All encrypted values are validated against strict Zod schemas before decryption.

## Credential policy

- New passwords must be at least 12 characters. Vaults created under the previous
  8-character policy can still be unlocked; consider re-encrypting by changing the
  password in Settings.
- New PINs must be at least 6 digits. Wallets protected by an older 4-digit PIN can
  still be unlocked; switch to a longer PIN or password protection in Settings.
- Choosing `unsecured` protection requires typing the confirmation phrase
  `UNSECURED`, and stores the wallet key unencrypted in browser storage. Only use it
  for throwaway or demo wallets with no funds.

## Deployment hardening

The web app is served with a restrictive Content-Security-Policy, HSTS with preload,
`X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy`, `Referrer-Policy`,
`Permissions-Policy` and `X-Content-Type-Options` (see `apps/web/public/_headers`).

The UI simulates and inspects transactions before signing, warns on unknown programs
and suspicious instructions, applies replay protection to sign requests, auto-locks
the vault after inactivity, and keeps an audit log of sensitive operations.

## Known limitations

- **Hot wallet risk.** A browser wallet cannot match hardware-wallet security. A
  compromised browser (XSS, malicious extension, malware) can access the decrypted
  keys while the wallet is unlocked, or exfiltrate the encrypted vault for offline
  cracking. Keep your OS and browser updated, install as few extensions as possible,
  and do not store more funds than you can afford to lose.
- **JavaScript memory.** WebCrypto does not offer true memory zeroization; key
  material lives in JS memory while the vault is unlocked. `lock()` drops the
  references but cannot guarantee immediate erasure.
- **Browser storage.** IndexedDB content is readable by any script running on the
  wallet origin and by anything with OS-level access to the browser profile.
- **No external audit yet.** This code has had internal security reviews and
  automated tests, but no independent professional audit. Do not import seeds
  holding significant funds.
- **No hardware wallet support yet.** Ledger or similar support is the recommended
  future hardening step for high-value wallets.

## Best practices

- Prefer password protection over PIN, and never use `unsecured` for funded wallets.
- Verify the site URL before entering any credential or importing a seed phrase.
- Keep significant funds on a hardware wallet; treat this wallet as a spending
  wallet.
- Lock the wallet when not in use and use OS-level disk encryption.
