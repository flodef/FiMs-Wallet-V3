// Devnet E2E check of the custodial deposit/redeem pipeline.
// Uses the devnet test wallet as custodial + a throwaway member account.
// Expects the mints created by create-fims-mints.ts --test-backing.
import { readFileSync, writeFileSync } from 'node:fs'
import {
  appendTransactionMessageInstructions,
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  type Instruction,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type TransactionSigner,
} from '@solana/kit'
import { getTransferSolInstruction } from '@solana-program/system'
import { findAssociatedTokenPda } from '@solana-program/token'
import {
  getCreateAssociatedTokenIdempotentInstruction,
  getMintToInstruction,
  getTransferCheckedInstruction,
  TOKEN_2022_PROGRAM_ADDRESS,
} from '@solana-program/token-2022'
import {
  custodialAddress,
  custodialMint,
  custodialRedeem,
  productForBackingMint,
  productForWrappedMint,
  wrappedProductConfig,
} from '../src/custodial.js'
import { fetchDonationTransaction } from '../src/solana-rpc.js'

// Env for this test — set before imports take effect below via process.env.
const RPC = process.env['TEST_RPC_URL'] ?? 'https://api.devnet.solana.com'
process.env['SOLANA_RPC_URL'] = RPC
process.env['CUSTODIAL_KEYPAIR'] = JSON.stringify(
  expandSecret(JSON.parse(readFileSync(`${process.env['HOME']}/.config/fims/devnet-test-wallet.json`, 'utf8'))),
)
process.env['FIMS_EURO_MINT'] ??= '92R6uXSFYVyypkWEmUyMnoAySHDYnxfjzJTQnEHikeqr'
process.env['FIMS_USD_MINT'] ??= 'A4oVEtZMiSnPTXwkssgjDXRu1joThHUVmTrD6qRkTVmG'
process.env['FIMS_EURO_BACKING_MINT'] ??= 'KhfpgGZCfiaSAqsfiDQCBsJo2MQLcdDcHifFu2BYTEX'
process.env['FIMS_USD_BACKING_MINT'] ??= '85dCDXnuXKu6pspWmhUAftn8RD6oQKB9n1DLSwtE5DGT'

function expandSecret(json: { address: string; seed: number[] }): number[] {
  // cspell:ignore ABCDEFGHJKLMNPQRSTUVWXY Zabcdefghijkmnopqrstuvwxyz
  // 32-byte seed + public key = 64-byte ed25519 secret key — derive pubkey bytes
  // from the base58 address.
  const pub = decodeBase58(json.address)
  return [...json.seed, ...pub]
}
function decodeBase58(text: string): number[] {
  const alpha = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  const digits = [0]
  for (const c of text) {
    let carry = alpha.indexOf(c)
    for (let i = 0; i < digits.length; i++) {
      carry += (digits[i] ?? 0) * 58
      digits[i] = carry & 0xff
      carry >>= 8
    }
    while (carry) {
      digits.push(carry & 0xff)
      carry >>= 8
    }
  }
  for (const c of text) {
    if (c !== '1') break
    digits.push(0)
  }
  return digits.reverse()
}

const rpc = createSolanaRpc(RPC)

// Local validators proxy upstream RPCs and rate-limit sporadically — retry
// any transient failure a few times before giving up.
async function call<T>(fn: () => Promise<T>, tag = ''): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (e) {
      if (i > 20 || !`${e}`.includes('429')) throw e
      console.log(`retry ${tag} (${i + 1})`)
      await new Promise((r) => setTimeout(r, 3000))
    }
  }
}
const custodial = await createKeyPairSignerFromPrivateKeyBytes(
  Uint8Array.from(
    (
      JSON.parse(readFileSync(`${process.env['HOME']}/.config/fims/devnet-test-wallet.json`, 'utf8')) as {
        seed: number[]
      }
    ).seed,
  ),
)
// Reuse a persistent member keypair across runs: airdrops are rate-limited.
const memberPath = '/tmp/fims-test-member.json'
let memberSeed: Uint8Array
try {
  memberSeed = Uint8Array.from(JSON.parse(readFileSync(memberPath, 'utf8')) as number[])
} catch {
  memberSeed = crypto.getRandomValues(new Uint8Array(32))
  writeFileSync(memberPath, JSON.stringify([...memberSeed]))
}
const member = await createKeyPairSignerFromPrivateKeyBytes(memberSeed)

async function send(signer: TransactionSigner, instructions: Instruction[]) {
  const { value: blockhash } = await call(() => rpc.getLatestBlockhash().send(), 'blockhash')
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => appendTransactionMessageInstructions(instructions, tx),
    (tx) => setTransactionMessageFeePayerSigner(signer, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(blockhash, tx),
  )
  const signed = await signTransactionMessageWithSigners(msg)
  const signature = await call(() =>
    rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: 'base64' }).send(),
  )
  for (let i = 0; i < 40; i++) {
    const { value } = await call(() => rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send())
    if (value[0]?.err) throw new Error(`tx failed: ${JSON.stringify(value[0].err)}`)
    if (value[0] && (value[0].confirmationStatus === 'confirmed' || value[0].confirmationStatus === 'finalized'))
      return signature
    await new Promise((r) => setTimeout(r, 750))
  }
  throw new Error('confirmation timeout')
}

const ata = async (mint: string, owner: string) =>
  (
    await findAssociatedTokenPda({
      mint: mint as never,
      owner: owner as never,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    })
  )[0]

// 1. Fund member with SOL + mint 50 tEURC
console.log('member:', member.address)
if ((await call(() => rpc.getBalance(member.address).send(), 'balance')).value < 5_000_000n) {
  await send(custodial, [
    getTransferSolInstruction({ amount: lamports(20_000_000n), destination: member.address, source: custodial }),
  ])
}
await new Promise((r) => setTimeout(r, 2000))
const backingMint = `${wrappedProductConfig('fims-eur')?.backingMint}`
const memberBackingAta = await ata(backingMint, member.address)
await send(custodial, [
  getCreateAssociatedTokenIdempotentInstruction({
    ata: memberBackingAta,
    mint: backingMint as never,
    owner: member.address,
    payer: custodial,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  }),
  getMintToInstruction(
    {
      amount: 50_000_000n,
      mint: backingMint as never,
      mintAuthority: custodial,
      token: memberBackingAta,
    },
    { programAddress: TOKEN_2022_PROGRAM_ADDRESS },
  ),
])
console.log('member funded: 50 tEURC')

// 2. Member deposits 40 tEURC to custody
const custodyAddr = await custodialAddress()
const custodyBackingAta = await ata(backingMint, `${custodyAddr}`)
const depositSig = await send(member, [
  getCreateAssociatedTokenIdempotentInstruction({
    ata: custodyBackingAta,
    mint: backingMint as never,
    owner: custodyAddr,
    payer: member,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  }),
  getTransferCheckedInstruction(
    {
      amount: 40_000_000n,
      authority: member,
      decimals: 6,
      destination: custodyBackingAta,
      mint: backingMint as never,
      source: memberBackingAta,
    },
    { programAddress: TOKEN_2022_PROGRAM_ADDRESS },
  ),
])
console.log('deposit sig:', depositSig)

// 3. Verify on-chain + mint
const tx = await fetchDonationTransaction(`${depositSig}`, `${custodyAddr}`)
console.log('deltas:', JSON.stringify(tx?.deltas))
const product = tx?.deltas.map((d) => productForBackingMint(d.mint)).find(Boolean)
console.log('product:', product)
if (product !== 'fims-eur') throw new Error('backing not detected')
// EURF units = backing / price index (tokens table — mirrors the handler).
const price = Number(process.env['TEST_PRODUCT_PRICE'] ?? '1.18622801457467')
const productUnits = BigInt(Math.round((40 / price) * 1e6))
console.log('minting EURF units:', `${productUnits}`)
const mintSig = await custodialMint('fims-eur', member.address, productUnits, 40_000_000n)
console.log('custodial mint sig:', mintSig)

// 4. Member redeems 10 EURF
const fimsMint = `${wrappedProductConfig('fims-eur')?.mint}`
const memberFimsAta = await ata(fimsMint, member.address)
const custodyFimsAta = await ata(fimsMint, `${custodyAddr}`)
const redeemSig = await send(member, [
  getCreateAssociatedTokenIdempotentInstruction({
    ata: custodyFimsAta,
    mint: fimsMint as never,
    owner: custodyAddr,
    payer: member,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  }),
  getTransferCheckedInstruction(
    {
      amount: 10_000_000n,
      authority: member,
      decimals: 6,
      destination: custodyFimsAta,
      mint: fimsMint as never,
      source: memberFimsAta,
    },
    { programAddress: TOKEN_2022_PROGRAM_ADDRESS },
  ),
])
console.log('redeem send sig:', redeemSig)
const tx2 = await fetchDonationTransaction(`${redeemSig}`, `${custodyAddr}`)
console.log('deltas:', JSON.stringify(tx2?.deltas))
const product2 = tx2?.deltas.map((d) => productForWrappedMint(d.mint)).find(Boolean)
console.log('product:', product2)
if (product2 !== 'fims-eur') throw new Error('wrapped mint not detected')
// backing returned = product units * price index.
const backingUnits = BigInt(Math.round(10 * price * 1e6))
console.log('returning backing units:', `${backingUnits}`)
const redeemDoneSig = await custodialRedeem('fims-eur', member.address, 10_000_000n, backingUnits)
console.log('custodial redeem sig:', redeemDoneSig)
console.log('OK — full deposit/redeem cycle passed')
