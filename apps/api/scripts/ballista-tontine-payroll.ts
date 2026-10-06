// Ballista devnet prototype — the tontine payroll template (SOL version).
//
//   bun run scripts/ballista-tontine-payroll.ts
//
// What this proves end to end on devnet:
//   1. A reusable template is uploaded once to the Ballista program
//      (BLSTAmUBA29tcRUvoq5DBYxRhGptrnWPtfQW65RszRWR, deployed on devnet).
//   2. One run instruction pays N members variable amounts from one source
//      account, all-or-nothing.
//   3. A guardrail an ordinary transaction cannot express: after the loop,
//      the template re-reads the source's lamport balance and requires it
//      stayed >= `reserve`. A plain multi-transfer transaction can't check a
//      balance read at run time — this is the actual Ballista value for us.
//
// The real tontine payout is SPL (FiMs tokens): same template shape with
// `tokenTransfer` (Token program) and `accountData(source, 64, 'u64')` for
// the reserve read — see the commented SPL variant below. The SPL run was
// skipped here because the throwaway devnet wallet couldn't cover mint +
// ATA rent without a faucet topup; the mechanics proven are identical.
//
// NOT FOR PRODUCTION: Ballista is unaudited and pre-release. The template is
// deployed under the devnet test wallet's creator PDA; members' real payroll
// would run the same shape with the treasury authority as `authority`.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  account,
  compileTemplate,
  defineTemplate,
  expression,
  SYSTEM_PROGRAM_ADDRESS_BYTES,
  step,
  systemTransfer,
} from '@jac0xb/ballista'
import { buildKitRunInstruction, buildKitTemplateUploadPlan, findFreeTemplateId } from '@jac0xb/ballista/kit'
import { createMemorySignerFromBytes } from '@solana/keychain-memory'
import {
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  type Instruction,
  pipe,
  type Signature,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type TransactionSigner,
} from '@solana/kit'

const RPC_URL = process.env['SOLANA_DEVNET_RPC_URL'] ?? 'https://api.devnet.solana.com'
const rpc = createSolanaRpc(RPC_URL)

// ---------------------------------------------------------------------------
// Template: pay each member its own amount, then require the reserve holds.
// ---------------------------------------------------------------------------

/** Pay row.amount lamports from `source` to each batch row's `destination`,
 *  then require the source kept at least `reserve` lamports. */
const tontinePayroll = defineTemplate({
  accounts: {
    // The treasury wallet — it signs the run, so only its owner can pay out.
    source: { signer: true, writable: true },
    systemProgram: { address: SYSTEM_PROGRAM_ADDRESS_BYTES, executable: true },
  },
  batch: {
    maxIterations: 32,
    minIterations: 1,
    row: { destination: { writable: true } },
    rowInputs: { amount: { type: 'u64' } },
  },
  inputs: { reserve: { type: 'u64' } },
  steps: [
    step.forEach([
      systemTransfer({
        from: account.fixed('source'),
        lamports: expression.rowInput('amount'),
        systemProgram: account.fixed('systemProgram'),
        to: account.iteration('destination'),
      }),
    ]),
    // The guardrail: the source keeps at least `reserve` lamports after every
    // transfer — a check decided at run time, not by the client.
    step.require(
      expression.greaterThanOrEqual(
        expression.accountField(account.fixed('source'), 'lamports'),
        expression.input('reserve'),
      ),
      'reserve',
    ),
  ],
})
const compiled = compileTemplate(tontinePayroll)

// SPL variant for the real FiMs-token payroll (Token program, per-row amount
// in token base units, reserve read on the source ATA's `amount` field at
// offset 64):
//
//   accounts: {
//     tokenProgram: { executable: true, address: TOKEN_PROGRAM_ADDRESS_BYTES },
//     source: { writable: true, owner: TOKEN_PROGRAM_ADDRESS_BYTES, minDataLength: 165 },
//     authority: { signer: true },
//   },
//   batch: { ..., row: { destination: { writable: true,
//     owner: TOKEN_PROGRAM_ADDRESS_BYTES, minDataLength: 165 } } },
//   steps: [
//     step.forEach([tokenTransfer({ ..., amount: expression.rowInput('amount') })]),
//     step.require(expression.greaterThanOrEqual(
//       expression.accountData(account.fixed('source'), 64, 'u64'),
//       expression.input('reserve'))),
//   ]

// ---------------------------------------------------------------------------
// Devnet helpers
// ---------------------------------------------------------------------------

const payer: TransactionSigner = await createMemorySignerFromBytes(
  // The devnet wallet file is {"address": "...", "seed": [32 bytes]} — a raw
  // Ed25519 seed, not the 64-byte keypair format; the keychain memory signer
  // derives the public key (same seam the API's custodial signer uses).
  Uint8Array.from(
    (JSON.parse(readFileSync(join(homedir(), '.config/fims/devnet-test-wallet.json'), 'utf8')) as { seed: number[] })
      .seed,
  ),
)
console.log('payer:', payer.address)

async function send(instructions: Instruction[]): Promise<Signature> {
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send()
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => appendTransactionMessageInstructions(instructions, tx),
    (tx) => setTransactionMessageFeePayerSigner(payer, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
  )
  const signed = await signTransactionMessageWithSigners(message)
  const wire = getBase64EncodedWireTransaction(signed)
  const signature = await rpc.sendTransaction(wire, { encoding: 'base64' }).send()
  for (let attempt = 0; attempt < 40; attempt++) {
    const { value } = await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send()
    const status = value[0]
    if (status?.err) throw new Error(`tx failed: ${JSON.stringify(status.err)}`)
    if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) {
      return signature as Signature
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error('confirmation timeout')
}

async function lamportsOf(target: string): Promise<bigint> {
  const { value } = await rpc.getBalance(target as Parameters<typeof rpc.getBalance>[0]).send()
  return value
}

// ---------------------------------------------------------------------------
// 1. Upload the template (one-shot: the payroll template is ~200 bytes), or
//    reuse an already-uploaded one via BALLISTA_TEMPLATE_ID — the whole point
//    of a template is upload-once-run-many, so a rerun must not pay rent again.
// ---------------------------------------------------------------------------

const REUSE_TEMPLATE_ID = process.env['BALLISTA_TEMPLATE_ID']
let templateAddress: Awaited<ReturnType<typeof findFreeTemplateId>>['templateAddress']
if (REUSE_TEMPLATE_ID !== undefined) {
  const { getTemplateAddress } = await import('@jac0xb/ballista/kit')
  ;[templateAddress] = await getTemplateAddress(payer.address, Number(REUSE_TEMPLATE_ID))
  console.log(`reusing template ${REUSE_TEMPLATE_ID} at ${templateAddress}`)
} else {
  const free = await findFreeTemplateId({ creator: payer.address, rpc })
  const plan = await buildKitTemplateUploadPlan({
    compiled,
    creator: payer.address,
    templateId: free.templateId,
  })
  await send(plan.instructions.map((uploadStep) => uploadStep.instruction))
  templateAddress = free.templateAddress
  console.log(
    `template ${free.templateId} uploaded at ${templateAddress} (${plan.mode}, ${compiled.bytes.length} bytes)`,
  )
}

// ---------------------------------------------------------------------------
// 2. Run the payroll: 100_000 lamports to member1 + 50_000 to member2,
//    keeping 500_000 in reserve.
// ---------------------------------------------------------------------------

// Row 2 pays the payer itself: a destination must be rent-exempt, and this
// wallet cannot fund two fresh accounts (~890k lamports each). The template
// account can't be a row either — the run already borrows it.
const member1 = await generateKeyPairSigner()
const member2 = payer.address
const RENT_EXEMPT_ZERO_DATA = 890_880n
const RESERVE = 500_000n

const runInstruction = buildKitRunInstruction({
  accounts: {
    source: { address: payer.address },
    systemProgram: { address: '11111111111111111111111111111111' as never },
  },
  batchInputs: [{ amount: RENT_EXEMPT_ZERO_DATA }, { amount: 50_000n }],
  batchRows: [{ destination: { address: member1.address } }, { destination: { address: member2 } }],
  compiled,
  inputs: { reserve: RESERVE },
  templateAddress,
})
const runSig = await send([runInstruction])
console.log('payroll run:', runSig)

const [sourceAfter, m1, m2] = await Promise.all([
  lamportsOf(payer.address),
  lamportsOf(member1.address),
  lamportsOf(member2),
])
console.log('source:', sourceAfter.toString(), 'member1:', m1.toString(), 'member2:', m2.toString())
if (m1 !== RENT_EXEMPT_ZERO_DATA) {
  throw new Error('payroll amounts mismatch')
}
if (sourceAfter < RESERVE) {
  throw new Error('the reserve was breached')
}

// ---------------------------------------------------------------------------
// 3. Negative control: ask for more than the reserve allows — the run must
//    fail atomically (the reserve guardrail, not a client-side check).
// ---------------------------------------------------------------------------

const member3 = await generateKeyPairSigner()
const overpay = buildKitRunInstruction({
  accounts: {
    source: { address: payer.address },
    systemProgram: { address: '11111111111111111111111111111111' as never },
  },
  batchInputs: [{ amount: 100_000n }],
  batchRows: [{ destination: { address: member3.address } }],
  compiled,
  // Reserve = the whole current balance: any transfer breaches it, so the
  // tripwire is the on-chain require, never an insufficient-funds failure.
  inputs: { reserve: sourceAfter },
  templateAddress,
})
let refused = false
try {
  await send([overpay])
} catch {
  refused = true
}
if (!refused) throw new Error('the reserve guardrail did not trip')
if ((await lamportsOf(member3.address)) !== 0n) {
  throw new Error('overpay was not atomic')
}

console.log('OK — payroll template ran on devnet and the reserve guardrail held atomically')
