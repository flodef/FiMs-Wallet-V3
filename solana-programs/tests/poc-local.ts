// PoC local validator: fims-strategy delegate-bounded CPI vault.
//   bun solana-programs/tests/poc-local.ts
// Requires: solana-test-validator running with the program deployed.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  type AccountMeta,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js'

const PROGRAM_ID = new PublicKey('AtmC4gPAEZ1r4fD698mDaCpGEC5WZN5f4z55zscsdVmS')
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
const MINT_SIZE = 82

const conn = new Connection('http://localhost:8899', 'confirmed')
const payer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(readFileSync(`${process.env.HOME}/.devnet-payer.json`, 'utf8'))),
)
const member = Keypair.generate()
const attacker = Keypair.generate()

const [statePda] = PublicKey.findProgramAddressSync([Buffer.from('state')], PROGRAM_ID)
const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from('vault')], PROGRAM_ID)

const disc = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8)
const borshVec = (items: Buffer[]) => Buffer.concat([Buffer.from(new Uint32Array([items.length]).buffer), ...items])
// Vec<u8> is length-prefixed in BYTES, not element count.
const borshBytes = (data: Buffer) => Buffer.concat([Buffer.from(new Uint32Array([data.length]).buffer), data])

async function send(ixs: TransactionInstruction[], signers: Keypair[], label: string) {
  const tx = new Transaction().add(...ixs)
  const sig = await conn.sendTransaction(tx, signers, { skipPreflight: false })
  await conn.confirmTransaction(sig, 'confirmed')
  console.log(`  ${label}: ${sig.slice(0, 20)}…`)
  return sig
}

async function trySend(ixs: TransactionInstruction[], signers: Keypair[], label: string) {
  try {
    await send(ixs, signers, label)
    console.log(`  ✗ ${label} SHOULD HAVE FAILED`)
    return false
  } catch (e) {
    const msg = String((e as Error).message)
    console.log(`  ✓ ${label} blocked: ${msg.slice(0, 100)}`)
    return true
  }
}

// ---- SPL token helpers (raw, no spl-token lib needed) ---------------------
const rent = (size: number) => conn.getMinimumBalanceForRentExemption(size)

function tokenAccount(owner: PublicKey, mint: PublicKey) {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM,
  )
  return ata
}

function createAtaIx(payerKey: PublicKey, ata: PublicKey, owner: PublicKey, mint: PublicKey) {
  return new TransactionInstruction({
    data: Buffer.alloc(0),
    keys: [
      { isSigner: true, isWritable: true, pubkey: payerKey },
      { isSigner: false, isWritable: true, pubkey: ata },
      { isSigner: false, isWritable: false, pubkey: owner },
      { isSigner: false, isWritable: false, pubkey: mint },
      { isSigner: false, isWritable: false, pubkey: SystemProgram.programId },
      { isSigner: false, isWritable: false, pubkey: TOKEN_PROGRAM },
    ],
    programId: ATA_PROGRAM,
  })
}

// ---- run -------------------------------------------------------------------
async function main() {
  console.log('PoC fims-strategy — validator local\nstate:', statePda.toBase58(), '\nvault:', vaultPda.toBase58())

  // 1. initialize (idempotent — state persists across program upgrades) ------
  const existing = await conn.getAccountInfo(statePda)
  if (existing) {
    console.log('  initialize: skipped (state exists)')
  } else {
    const initArgs = Buffer.concat([
      payer.publicKey.toBuffer(), // admin
      payer.publicKey.toBuffer(), // delegate
      payer.publicKey.toBuffer(), // treasury
      borshVec([TOKEN_PROGRAM.toBuffer(), SystemProgram.programId.toBuffer()]),
      borshVec([member.publicKey.toBuffer(), payer.publicKey.toBuffer()]),
      Buffer.from(new BigUint64Array([2_000_000_000n]).buffer), // daily cap 2 SOL
    ])
    await send(
      [
        new TransactionInstruction({
          data: Buffer.concat([disc('initialize'), initArgs]),
          keys: [
            { isSigner: true, isWritable: true, pubkey: payer.publicKey },
            { isSigner: false, isWritable: true, pubkey: statePda },
            { isSigner: false, isWritable: false, pubkey: vaultPda },
            { isSigner: false, isWritable: false, pubkey: SystemProgram.programId },
          ],
          programId: PROGRAM_ID,
        }),
      ],
      [payer],
      'initialize',
    )
  }

  // member whitelist must include this run's member (state may predate it)
  await send(
    [
      new TransactionInstruction({
        data: Buffer.concat([
          disc('set_member_whitelist'),
          borshVec([member.publicKey.toBuffer(), payer.publicKey.toBuffer()]),
        ]),
        keys: [
          { isSigner: true, isWritable: false, pubkey: payer.publicKey },
          { isSigner: false, isWritable: true, pubkey: statePda },
        ],
        programId: PROGRAM_ID,
      }),
    ],
    [payer],
    'set_member_whitelist',
  )

  // 2. fund the vault PDA + create test mint & vault ATA ----------------------
  const mint = Keypair.generate()
  const vaultAta = tokenAccount(vaultPda, mint.publicKey)
  const memberAta = tokenAccount(member.publicKey, mint.publicKey)
  await send(
    [
      SystemProgram.transfer({ fromPubkey: payer.publicKey, lamports: 500_000_000, toPubkey: vaultPda }),
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        lamports: await rent(MINT_SIZE),
        newAccountPubkey: mint.publicKey,
        programId: TOKEN_PROGRAM,
        space: MINT_SIZE,
      }),
      // initializeMint2: decimals=6, authority=payer, freeze=none
      new TransactionInstruction({
        data: Buffer.concat([Buffer.from([20, 6]), payer.publicKey.toBuffer(), Buffer.from([0])]),
        keys: [{ isSigner: false, isWritable: true, pubkey: mint.publicKey }],
        programId: TOKEN_PROGRAM,
      }),
      createAtaIx(payer.publicKey, vaultAta, vaultPda, mint.publicKey),
      // mintTo: 1000 tokens to vault ATA
      new TransactionInstruction({
        data: Buffer.concat([Buffer.from([7]), Buffer.from(new BigUint64Array([1_000_000_000n]).buffer)]),
        keys: [
          { isSigner: false, isWritable: true, pubkey: mint.publicKey },
          { isSigner: false, isWritable: true, pubkey: vaultAta },
          { isSigner: true, isWritable: false, pubkey: payer.publicKey },
        ],
        programId: TOKEN_PROGRAM,
      }),
      createAtaIx(payer.publicKey, memberAta, member.publicKey, mint.publicKey),
    ],
    [payer, mint],
    'fund vault + mint 1000 tokens to vault ATA',
  )

  // 3. cpi_signed: SPL transfer signed by the vault PDA -----------------------
  const innerTransfer = new TransactionInstruction({
    data: Buffer.concat([Buffer.from([3]), Buffer.from(new BigUint64Array([250_000_000n]).buffer)]),
    keys: [
      { isSigner: false, isWritable: true, pubkey: vaultAta },
      { isSigner: false, isWritable: true, pubkey: memberAta },
      { isSigner: true, isWritable: false, pubkey: vaultPda }, // owner = vault PDA
    ],
    programId: TOKEN_PROGRAM,
  })
  const cpiArgs = Buffer.concat([TOKEN_PROGRAM.toBuffer(), borshBytes(innerTransfer.data)])
  const cpiIx = new TransactionInstruction({
    data: Buffer.concat([disc('cpi_signed'), cpiArgs]),
    keys: [
      { isSigner: true, isWritable: false, pubkey: payer.publicKey }, // delegate
      { isSigner: false, isWritable: false, pubkey: statePda },
      { isSigner: false, isWritable: true, pubkey: vaultPda },
      ...innerTransfer.keys.map((k): AccountMeta => ({ ...k, isSigner: false })),
      { isSigner: false, isWritable: false, pubkey: TOKEN_PROGRAM },
    ],
    programId: PROGRAM_ID,
  })
  await send([cpiIx], [payer], 'cpi_signed → vault transfers 250 tokens to member')

  const vaultBal = await conn.getTokenAccountBalance(vaultAta)
  const memberBal = await conn.getTokenAccountBalance(memberAta)
  console.log(`  vault ATA: ${vaultBal.value.uiAmount} | member ATA: ${memberBal.value.uiAmount}`)

  // 4. payout to whitelisted member -------------------------------------------
  const payoutIx = (dest: PublicKey, amount: bigint, caller: PublicKey) =>
    new TransactionInstruction({
      data: Buffer.concat([disc('payout'), Buffer.from(new BigUint64Array([amount]).buffer)]),
      keys: [
        { isSigner: true, isWritable: false, pubkey: caller },
        { isSigner: false, isWritable: true, pubkey: statePda },
        { isSigner: false, isWritable: true, pubkey: vaultPda },
        { isSigner: false, isWritable: true, pubkey: dest },
        { isSigner: false, isWritable: false, pubkey: SystemProgram.programId },
      ],
      programId: PROGRAM_ID,
    })
  await send([payoutIx(member.publicKey, 50_000_000n, payer.publicKey)], [payer], 'payout 0.05 SOL → member')

  // 5. negative paths -----------------------------------------------------------
  const rogueCpi = new TransactionInstruction({
    data: cpiIx.data,
    keys: [
      { isSigner: true, isWritable: false, pubkey: attacker.publicKey },
      { isSigner: false, isWritable: false, pubkey: statePda },
      { isSigner: false, isWritable: true, pubkey: vaultPda },
      ...innerTransfer.keys.map((k): AccountMeta => ({ ...k, isSigner: false })),
      { isSigner: false, isWritable: false, pubkey: TOKEN_PROGRAM },
    ],
    programId: PROGRAM_ID,
  })
  await send(
    [SystemProgram.transfer({ fromPubkey: payer.publicKey, lamports: 10_000_000, toPubkey: attacker.publicKey })],
    [payer],
    'fund attacker',
  )
  await trySend([rogueCpi], [attacker], 'attacker cpi_signed')
  await trySend(
    [payoutIx(attacker.publicKey, 50_000_000n, payer.publicKey)],
    [payer],
    'payout → non-whitelisted attacker',
  )
  await trySend([payoutIx(member.publicKey, 5_000_000_000n, payer.publicKey)], [payer], 'payout 5 SOL over daily cap')
  console.log('\nDone.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
