// Create the Token-2022 mints behind the custodial wrapped products.
//
//   bun scripts/create-fims-mints.ts --keypair ~/.config/fims/custodial.json \
//     [--rpc https://api.mainnet-beta.solana.com] [--test-backing]
//
// --keypair   JSON byte-array secret key; becomes mint + metadata authority.
//             MUST be the key later set as CUSTODIAL_KEYPAIR on the worker.
// --test-backing  devnet only: also creates tEURC/tUSDG test mints under the
//             same authority and mints 1 000 units of each to the payer, so
//             the whole deposit/redeem flow can be exercised end-to-end.
//
// Prints the env values to paste into wrangler secrets / .dev.vars.
import { readFileSync } from 'node:fs'
import {
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  type Instruction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit'
import { getCreateAccountInstruction } from '@solana-program/system'
import { findAssociatedTokenPda } from '@solana-program/token'
import {
  extension,
  getCreateAssociatedTokenIdempotentInstruction,
  getInitializeMetadataPointerInstruction,
  getInitializeMint2Instruction,
  getInitializeTokenMetadataInstruction,
  getMintSize,
  getMintToInstruction,
  TOKEN_2022_PROGRAM_ADDRESS,
} from '@solana-program/token-2022'

const args = process.argv.slice(2)
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const keypairPath = arg('keypair')
const rpcUrl = arg('rpc') ?? 'https://api.devnet.solana.com'
const testBacking = args.includes('--test-backing')
if (!keypairPath) {
  console.error('usage: --keypair <json> [--rpc <url>] [--test-backing]')
  process.exit(1)
}

const keypairJson = JSON.parse(readFileSync(keypairPath, 'utf8')) as number[] | { seed: number[] }
const payer = Array.isArray(keypairJson)
  ? await createKeyPairSignerFromBytes(Uint8Array.from(keypairJson))
  : await createKeyPairSignerFromPrivateKeyBytes(Uint8Array.from(keypairJson.seed))
const rpc = createSolanaRpc(rpcUrl)
console.log(`payer/custodial: ${payer.address}`)
console.log(`rpc: ${rpcUrl}`)

async function send(instructions: Instruction[]): Promise<void> {
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send()
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => appendTransactionMessageInstructions(instructions, tx),
    (tx) => setTransactionMessageFeePayerSigner(payer, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
  )
  const signed = await signTransactionMessageWithSigners(message)
  const signature = await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: 'base64' }).send()
  console.log(`  sig: ${signature}`)
  for (let i = 0; i < 40; i++) {
    const { value } = await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send()
    const status = value[0]
    if (status?.err) throw new Error(`tx failed: ${JSON.stringify(status.err)}`)
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return
    await new Promise((resolve) => setTimeout(resolve, 750))
  }
  throw new Error('confirmation timeout')
}

async function createMint(name: string, symbol: string, supplyTo?: bigint): Promise<string> {
  const mint = await generateKeyPairSigner()
  // Only the pointer extension is reserved up front: InitializeMint rejects
  // accounts sized for not-yet-written extensions, and TokenMetadataInstruction
  // reallocates the mint itself when it writes metadata. The realloc cannot pull
  // lamports from the payer, so the account is created with the rent of its
  // FINAL size (pointer + metadata) while only the pointer size is allocated.
  const space = getMintSize([extension('MetadataPointer', { authority: payer.address, metadataAddress: mint.address })])
  const finalSpace = getMintSize([
    extension('MetadataPointer', { authority: payer.address, metadataAddress: mint.address }),
    extension('TokenMetadata', {
      additionalMetadata: new Map(),
      mint: mint.address,
      name,
      symbol,
      updateAuthority: payer.address,
      uri: '',
    }),
  ])
  const rent = await rpc.getMinimumBalanceForRentExemption(BigInt(finalSpace)).send()
  const instructions: Instruction[] = [
    getCreateAccountInstruction({
      lamports: rent,
      newAccount: mint,
      payer,
      programAddress: TOKEN_2022_PROGRAM_ADDRESS,
      space,
    }),
    getInitializeMetadataPointerInstruction({
      authority: payer.address,
      metadataAddress: mint.address,
      mint: mint.address,
    }),
    getInitializeMint2Instruction({ decimals: 6, mint: mint.address, mintAuthority: payer.address }),
    getInitializeTokenMetadataInstruction({
      metadata: mint.address,
      mint: mint.address,
      mintAuthority: payer,
      name,
      symbol,
      updateAuthority: payer.address,
      uri: '',
    }),
  ]
  if (supplyTo) {
    const [ata] = await findAssociatedTokenPda({
      mint: mint.address,
      owner: payer.address,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    })
    instructions.push(
      getCreateAssociatedTokenIdempotentInstruction({
        ata,
        mint: mint.address,
        owner: payer.address,
        payer,
        tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      }),
      getMintToInstruction({ amount: supplyTo, mint: mint.address, mintAuthority: payer, token: ata }),
    )
  }
  await send(instructions)
  console.log(`  ${symbol}: ${mint.address}`)
  return mint.address
}

// Symbols are EURC/USDC (not FiMsEUR/FiMsUSD) so wallets display the wrapped
// position in the backing currency — members only ever see EURC/USDC.
const fimsEur = await createMint('FiMs Euro', 'EURC')
const fimsUsd = await createMint('FiMs USD', 'USDC')

console.log('\n# env')
console.log(`FIMS_EURO_MINT=${fimsEur}`)
console.log(`FIMS_USD_MINT=${fimsUsd}`)

if (testBacking) {
  const eurBacking = await createMint('Test EURC', 'tEURC', 1_000_000_000n)
  const usdBacking = await createMint('Test USDG', 'tUSDG', 1_000_000_000n)
  console.log(`FIMS_EURO_BACKING_MINT=${eurBacking}`)
  console.log(`FIMS_USD_BACKING_MINT=${usdBacking}`)
}
