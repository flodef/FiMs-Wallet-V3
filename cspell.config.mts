import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CSpellSettings } from 'cspell'

function findPackageJsonFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules') return []
    const full = join(directory, e.name)
    return e.isDirectory() ? findPackageJsonFiles(full) : e.name === 'package.json' ? [full] : []
  })
}

function getAllDependencies(pkgPath: string): string[] {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  return [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies, pkg.optionalDependencies, pkg.catalog]
    .flatMap((deps) => Object.keys(deps || {}))
    .flatMap((dep) => dep.replace('@', '').split(/[/-]/))
}

export function getPackageNames(): string[] {
  const allDeps = new Set<string>(findPackageJsonFiles('.').flatMap(getAllDependencies))
  return [...allDeps].sort()
}

const config: CSpellSettings = {
  dictionaries: ['fullstack', 'html', 'css'],
  ignorePaths: ['docs/security-audit.md', 'drizzle'],
  import: ['@cspell/dict-es-es/cspell-ext.json', '@cspell/dict-fr-fr/cspell-ext.json'],
  overrides: [
    {
      filename: '**/es/*.json',
      language: 'en, es',
    },
    {
      filename: '**/fr/*.json',
      language: 'en, fr',
    },
    {
      filename: 'apps/web/src/landing/**/*',
      language: 'en, fr',
    },
  ],
  useGitignore: true,
  words: [
    'borsh',
    'cdylib',
    'codegen',
    'Jdjwb',
    'JLP',
    'Kamino',
    'PDA',
    'pubkeys',
    'Rpesrt',
    'timelock',
    'timelocked',
    'ATA',
    'ATAs',
    'Upgradeab',
    'vecs',
    'HSTS',
    'zeroization',
    'Solflare',
    'eurc',
    'EURF',
    'USDF',
    ...getPackageNames(),
    // English
    'arweave',
    'beeman',
    'bitpanda',
    'blockhash',
    'bootsplash',
    'bunx',
    'cipherparams',
    'ciphertext',
    'cooldown',
    'cypherpunk',
    'cutover',
    'datetimepicker',
    'dedup',
    'devnet',
    'nosniff',
    'novault',
    'otpauth',
    'replayable',
    'snzm',
    'spoofable',
    'dca',
    'dklen',
    'dyor',
    'ellipsify',
    'jupsol',
    'topup',
    'EURC',
    'fims',
    'FSOL',
    'USDG',
    'USDS',
    'fimsfi',
    'fimseur',
    'firestore',
    'hackathon',
    'hdkey',
    'helius',
    'ilike',
    'ispublic',
    'kdfparams',
    'lamport',
    'lamports',
    'wsol',
    'lironer',
    'localnet',
    'mainnet',
    'metaplex',
    'metas',
    'multisig',
    'multisigs',
    'pdas',
    'sqds',
    'uncompiled',
    'netinfo',
    'rebalance',
    'nvmrc',
    'nums',
    'reprotect',
    'rtishchev',
    'samui',
    'seti',
    'sidepanel',
    'skia',
    'solscan',
    'stablecoins',
    'surfpool',
    'sysvar',
    'testnet',
    'totp',
    'travelling',
    'tobeycodes',
    'unimodules',
    'unruggable',
    'unstake',
    'vercel',
    'flodef',
    'flojito',
    'stillnets',
    'reshare',
    'viewpager',
    'vitaly',
    'wordlist',
    'wordlists',
    'worklets',
    // French
    'authentificateur',
    'démo',
    'dispo',
    'français',
    // Spanish
    'agregador',
    'autenticador',
    'biométrico',
    'español',
    'anualizada',
    'ilíquido',
    'cripto',
    'mnemónica',
    'modifícalo',
    'multifirma',
    'rebalancear',
    'rebalanceo',
    'redirecciona',
  ],
}

export default config
