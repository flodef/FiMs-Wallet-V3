// PoC local validator: fims-strategy post-conditioned strategy vault.
//   bun solana-programs/tests/poc-local.ts
// Requires: solana-test-validator running with the program deployed
//   (validator must be fresh — state layout changed; restart with --reset).
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
const BPF_UPGRADEABLE = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111')
const MINT_SIZE = 82

const conn = new Connection('http://localhost:8899', 'confirmed')
// The deployer of the program — also the upgrade authority, required by
// initialize (front-running protection).
const payer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(readFileSync(`${process.env.HOME}/.devnet-payer.json`, 'utf8'))),
)
// Deterministic keys so whitelist entries stay valid across runs.
const member = Keypair.fromSeed(createHash('sha256').update('fims-poc-member').digest())
const guardian = Keypair.fromSeed(createHash('sha256').update('fims-poc-guardian').digest())
const newAdmin = Keypair.fromSeed(createHash('sha256').update('fims-poc-new-admin').digest())
const attacker = Keypair.generate()

const [statePda] = PublicKey.findProgramAddressSync([Buffer.from('state')], PROGRAM_ID)
const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from('vault')], PROGRAM_ID)
const [programDataPda] = PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], BPF_UPGRADEABLE)

const disc = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8)
const borshVec = (items: Buffer[]) => Buffer.concat([u32(items.length), ...items])
const borshBytes = (data: Buffer) => Buffer.concat([u32(data.length), data])
const u32 = (n: number) => Buffer.from(new Uint32Array([n]).buffer)
const u64 = (n: bigint) => Buffer.from(new BigUint64Array([n]).buffer)

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
    console.log(`  ✓ ${label} blocked: ${String((e as Error).message).slice(0, 90)}`)
    return true
  }
}

// ---- SPL token helpers -----------------------------------------------------

function ataOf(owner: PublicKey, mint: PublicKey) {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0]
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

function tokenTransferIx(from: PublicKey, to: PublicKey, owner: PublicKey, amount: bigint) {
  return new TransactionInstruction({
    data: Buffer.concat([Buffer.from([3]), u64(amount)]),
    keys: [
      { isSigner: false, isWritable: true, pubkey: from },
      { isSigner: false, isWritable: true, pubkey: to },
      { isSigner: true, isWritable: false, pubkey: owner },
    ],
    programId: TOKEN_PROGRAM,
  })
}

const stateKeys = (caller: PublicKey, mut = false): AccountMeta[] => [
  { isSigner: true, isWritable: false, pubkey: caller },
  { isSigner: false, isWritable: mut, pubkey: statePda },
]

// ---- run -------------------------------------------------------------------
async function main() {
  console.log('PoC fims-strategy — validator local\nstate:', statePda.toBase58(), '\nvault:', vaultPda.toBase58())

  // deterministic mints so the whitelisted swap pair survives reruns
  const mintA = Keypair.fromSeed(createHash('sha256').update('fims-poc-mintA').digest())
  const mintB = Keypair.fromSeed(createHash('sha256').update('fims-poc-mintB').digest())
  const vaultAtaA = ataOf(vaultPda, mintA.publicKey)
  const vaultAtaB = ataOf(vaultPda, mintB.publicKey)
  const memberAtaA = ataOf(member.publicKey, mintA.publicKey)
  const treasuryAtaA = ataOf(payer.publicKey, mintA.publicKey) // treasury=payer
  const attackerAtaA = ataOf(attacker.publicKey, mintA.publicKey)

  // 1. initialize — restricted to the program upgrade authority --------------
  // InitializeArgs: admin, delegate, guardian, treasury, allowed_programs,
  // member_whitelist, strategies, allowed_mint_pairs, daily_cap, tx_cap,
  // daily_token_cap
  const mintPair = Buffer.concat([mintA.publicKey.toBuffer(), mintB.publicKey.toBuffer()])
  const initArgs = Buffer.concat([
    payer.publicKey.toBuffer(), // admin
    payer.publicKey.toBuffer(), // delegate
    guardian.publicKey.toBuffer(), // guardian
    payer.publicKey.toBuffer(), // treasury
    // Generic transfer programs (SPL token, system, ATA) are rejected by
    // validate_whitelists — a CPI through them has no protocol-side witness.
    borshVec([]),
    borshVec([member.publicKey.toBuffer(), payer.publicKey.toBuffer()]),
    borshVec([]), // strategies — none on localnet (no Fluid positions)
    borshVec([mintPair]), // allowed_mint_pairs: A→B for the swap test
    u64(2_000_000_000n), // daily cap 2 SOL
    u64(500_000_000n), // per-tx cap 0.5 SOL
    u64(400_000_000n), // daily token cap 400 tokens (6 dec)
  ])
  const alreadyInitialized = await conn.getAccountInfo(statePda)
  if (!alreadyInitialized) {
    await send(
      [
        new TransactionInstruction({
          data: Buffer.concat([disc('initialize'), initArgs]),
          keys: [
            { isSigner: true, isWritable: true, pubkey: payer.publicKey },
            { isSigner: false, isWritable: true, pubkey: statePda },
            { isSigner: false, isWritable: false, pubkey: vaultPda },
            { isSigner: false, isWritable: false, pubkey: PROGRAM_ID }, // this_program
            { isSigner: false, isWritable: false, pubkey: programDataPda },
            { isSigner: false, isWritable: false, pubkey: SystemProgram.programId },
          ],
          programId: PROGRAM_ID,
        }),
      ],
      [payer],
      'initialize (upgrade-authority gated)',
    )
  } else {
    console.log('  initialize: skipped (state exists)')
  }
  await trySend(
    [
      new TransactionInstruction({
        data: Buffer.concat([disc('initialize'), initArgs]),
        keys: [
          { isSigner: true, isWritable: true, pubkey: payer.publicKey },
          { isSigner: false, isWritable: true, pubkey: statePda },
          { isSigner: false, isWritable: false, pubkey: vaultPda },
          { isSigner: false, isWritable: false, pubkey: PROGRAM_ID },
          { isSigner: false, isWritable: false, pubkey: programDataPda },
          { isSigner: false, isWritable: false, pubkey: SystemProgram.programId },
        ],
        programId: PROGRAM_ID,
      }),
    ],
    [payer],
    're-initialize',
  )

  // 2. fund vault + mints/ATAs -------------------------------------------------
  const mintIx = (mint: Keypair) => [
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      lamports: 1_500_000,
      newAccountPubkey: mint.publicKey,
      programId: TOKEN_PROGRAM,
      space: MINT_SIZE,
    }),
    new TransactionInstruction({
      data: Buffer.concat([Buffer.from([20, 6]), payer.publicKey.toBuffer(), Buffer.from([0])]),
      keys: [{ isSigner: false, isWritable: true, pubkey: mint.publicKey }],
      programId: TOKEN_PROGRAM,
    }),
  ]
  if (!alreadyInitialized) {
    await send(
      [
        SystemProgram.transfer({ fromPubkey: payer.publicKey, lamports: 500_000_000, toPubkey: vaultPda }),
        ...mintIx(mintA),
        ...mintIx(mintB),
        createAtaIx(payer.publicKey, vaultAtaA, vaultPda, mintA.publicKey),
        createAtaIx(payer.publicKey, vaultAtaB, vaultPda, mintB.publicKey),
        createAtaIx(payer.publicKey, memberAtaA, member.publicKey, mintA.publicKey),
        createAtaIx(payer.publicKey, treasuryAtaA, payer.publicKey, mintA.publicKey),
        createAtaIx(payer.publicKey, attackerAtaA, attacker.publicKey, mintA.publicKey),
        new TransactionInstruction({
          data: Buffer.concat([Buffer.from([7]), u64(1_000_000_000n)]),
          keys: [
            { isSigner: false, isWritable: true, pubkey: mintA.publicKey },
            { isSigner: false, isWritable: true, pubkey: vaultAtaA },
            { isSigner: true, isWritable: false, pubkey: payer.publicKey },
          ],
          programId: TOKEN_PROGRAM,
        }),
      ],
      [payer, mintA, mintB],
      'fund vault + mint 1000 A-tokens to vault ATA',
    )
  }

  // timelocked config change: schedule a member-whitelist update and prove
  // it cannot apply before the 48h delay (borsh enum = u8 variant index).
  const memberList = borshVec([member.publicKey.toBuffer(), payer.publicKey.toBuffer(), attacker.publicKey.toBuffer()])
  const cfgArgs = Buffer.concat([Buffer.from([1]), memberList]) // ConfigChange::MemberWhitelist;
  await send(
    [
      new TransactionInstruction({
        data: Buffer.concat([disc('schedule_config'), cfgArgs]),
        keys: stateKeys(payer.publicKey, true),
        programId: PROGRAM_ID,
      }),
    ],
    [payer],
    'schedule_config (add attacker to member whitelist)',
  )
  await trySend(
    [
      new TransactionInstruction({
        data: disc('apply_config'),
        keys: stateKeys(payer.publicKey, true),
        programId: PROGRAM_ID,
      }),
    ],
    [payer],
    'apply_config before 48h timelock',
  )

  // 3. payout (SOL) ------------------------------------------------------------
  const payoutIx = (dest: PublicKey, amount: bigint) =>
    new TransactionInstruction({
      data: Buffer.concat([disc('payout'), u64(amount)]),
      keys: [
        { isSigner: true, isWritable: false, pubkey: payer.publicKey },
        { isSigner: false, isWritable: true, pubkey: statePda },
        { isSigner: false, isWritable: true, pubkey: vaultPda },
        { isSigner: false, isWritable: true, pubkey: dest },
        { isSigner: false, isWritable: false, pubkey: SystemProgram.programId },
      ],
      programId: PROGRAM_ID,
    })
  await send([payoutIx(member.publicKey, 50_000_000n)], [payer], 'payout 0.05 SOL → member')

  // 4. payout_token (SPL) -------------------------------------------------------
  const payoutTokenIx = (dest: PublicKey, amount: bigint) =>
    new TransactionInstruction({
      data: Buffer.concat([disc('payout_token'), mintA.publicKey.toBuffer(), u64(amount)]),
      keys: [
        { isSigner: true, isWritable: false, pubkey: payer.publicKey },
        { isSigner: false, isWritable: true, pubkey: statePda },
        { isSigner: false, isWritable: true, pubkey: vaultPda },
        { isSigner: false, isWritable: true, pubkey: vaultAtaA },
        { isSigner: false, isWritable: true, pubkey: dest },
        { isSigner: false, isWritable: false, pubkey: TOKEN_PROGRAM },
      ],
      programId: PROGRAM_ID,
    })
  await send([payoutTokenIx(memberAtaA, 100_000_000n)], [payer], 'payout_token 100 → member ATA')
  await trySend([payoutTokenIx(attackerAtaA, 100_000_000n)], [payer], 'payout_token → attacker ATA')
  await trySend([payoutTokenIx(memberAtaA, 500_000_000n)], [payer], 'payout_token over token cap')

  // 5. sweep → treasury only ----------------------------------------------------
  const sweepIx = (dest: PublicKey, amount: bigint) =>
    new TransactionInstruction({
      data: Buffer.concat([disc('sweep'), mintA.publicKey.toBuffer(), u64(amount)]),
      keys: [
        { isSigner: true, isWritable: false, pubkey: payer.publicKey },
        { isSigner: false, isWritable: false, pubkey: statePda },
        { isSigner: false, isWritable: true, pubkey: vaultPda },
        { isSigner: false, isWritable: true, pubkey: vaultAtaA },
        { isSigner: false, isWritable: true, pubkey: dest },
        { isSigner: false, isWritable: false, pubkey: TOKEN_PROGRAM },
      ],
      programId: PROGRAM_ID,
    })
  await send([sweepIx(treasuryAtaA, 50_000_000n)], [payer], 'sweep 50 → treasury ATA')
  await trySend([sweepIx(memberAtaA, 50_000_000n)], [payer], 'sweep → member ATA (wrong dest)')

  // 6. allowed_programs invariant: generic transfer programs must be refused --
  // through them a CPI has no protocol-side witness, so the post-conditions
  // could never see a crafted outflow. Whitelisting them would let the
  // delegate sign a plain vault -> anywhere transfer.
  const allowIxs = (programs: PublicKey[]) =>
    new TransactionInstruction({
      data: Buffer.concat([disc('schedule_config'), Buffer.from([0]), borshVec(programs.map((p) => p.toBuffer()))]),
      keys: stateKeys(payer.publicKey, true),
      programId: PROGRAM_ID,
    })
  await trySend([allowIxs([TOKEN_PROGRAM])], [payer], 'whitelist SPL token program')
  await trySend([allowIxs([SystemProgram.programId])], [payer], 'whitelist system program')
  await trySend([allowIxs([ATA_PROGRAM])], [payer], 'whitelist ATA program')
  await trySend([allowIxs([PROGRAM_ID])], [payer], 'whitelist self')

  // 7. CPI paths are all closed while allowed_programs is empty: every op is
  // rejected before reaching its inner instruction.
  const swapIx = (inner: TransactionInstruction, amount: bigint, minOut: bigint) =>
    new TransactionInstruction({
      data: Buffer.concat([
        disc('swap'),
        mintA.publicKey.toBuffer(),
        mintB.publicKey.toBuffer(),
        u64(amount),
        u64(minOut),
        borshBytes(inner.data),
      ]),
      keys: [
        { isSigner: true, isWritable: false, pubkey: payer.publicKey },
        { isSigner: false, isWritable: false, pubkey: statePda },
        { isSigner: false, isWritable: false, pubkey: vaultPda },
        ...inner.keys.map((k): AccountMeta => ({ ...k, isSigner: false })),
        { isSigner: false, isWritable: false, pubkey: TOKEN_PROGRAM }, // callee = last
      ],
      programId: PROGRAM_ID,
    })
  const drainInner = tokenTransferIx(vaultAtaA, attackerAtaA, vaultPda, 100_000_000n)
  await trySend([swapIx(drainInner, 100_000_000n, 1n)], [payer], 'swap with empty allowed_programs')
  // Positive CPI paths (swap, jl_operate, kamino_flow + the undeclared-ATA
  // guard) need a real whitelisted venue — covered on the mainnet-fork.

  // 8. governance ---------------------------------------------------------------
  const pauseIx = (caller: PublicKey, paused: boolean, guardianIx = false) =>
    new TransactionInstruction({
      data: guardianIx ? disc('guardian_pause') : Buffer.concat([disc('set_paused'), Buffer.from([paused ? 1 : 0])]),
      keys: [
        { isSigner: true, isWritable: false, pubkey: caller },
        { isSigner: false, isWritable: true, pubkey: statePda },
      ],
      programId: PROGRAM_ID,
    })
  await send(
    [SystemProgram.transfer({ fromPubkey: payer.publicKey, lamports: 10_000_000, toPubkey: guardian.publicKey })],
    [payer],
    'fund guardian',
  )
  await send([pauseIx(guardian.publicKey, true, true)], [guardian], 'guardian_pause')
  await trySend([payoutIx(member.publicKey, 10_000_000n)], [payer], 'payout while paused')
  await send([pauseIx(payer.publicKey, false)], [payer], 'admin unpause')
  await trySend([pauseIx(guardian.publicKey, false)], [guardian], 'guardian tries admin-only set_paused')

  // two-step admin handover
  const proposeIx = Buffer.concat([disc('propose_admin'), newAdmin.publicKey.toBuffer()])
  await send(
    [new TransactionInstruction({ data: proposeIx, keys: stateKeys(payer.publicKey, true), programId: PROGRAM_ID })],
    [payer],
    'propose_admin → newAdmin',
  )
  await trySend(
    [
      new TransactionInstruction({
        data: disc('accept_admin'),
        keys: [
          { isSigner: true, isWritable: false, pubkey: payer.publicKey },
          { isSigner: false, isWritable: true, pubkey: statePda },
        ],
        programId: PROGRAM_ID,
      }),
    ],
    [payer],
    'accept_admin by old admin',
  )
  await send(
    [SystemProgram.transfer({ fromPubkey: payer.publicKey, lamports: 10_000_000, toPubkey: newAdmin.publicKey })],
    [payer],
    'fund newAdmin',
  )
  await send(
    [
      new TransactionInstruction({
        data: disc('accept_admin'),
        keys: [
          { isSigner: true, isWritable: false, pubkey: newAdmin.publicKey },
          { isSigner: false, isWritable: true, pubkey: statePda },
        ],
        programId: PROGRAM_ID,
      }),
    ],
    [newAdmin],
    'accept_admin by proposed admin',
  )
  // old admin is no longer admin
  await trySend([pauseIx(payer.publicKey, true)], [payer], 'old admin set_paused')
  // rotate back for cleanliness
  await send(
    [
      new TransactionInstruction({
        data: Buffer.concat([disc('propose_admin'), payer.publicKey.toBuffer()]),
        keys: stateKeys(newAdmin.publicKey, true),
        programId: PROGRAM_ID,
      }),
    ],
    [newAdmin],
    'propose_admin → back to payer',
  )
  await send(
    [
      new TransactionInstruction({
        data: disc('accept_admin'),
        keys: [
          { isSigner: true, isWritable: false, pubkey: payer.publicKey },
          { isSigner: false, isWritable: true, pubkey: statePda },
        ],
        programId: PROGRAM_ID,
      }),
    ],
    [payer],
    'accept_admin → payer restored',
  )

  // 9. delegate-only ops are still delegate-only --------------------------------
  await send(
    [SystemProgram.transfer({ fromPubkey: payer.publicKey, lamports: 10_000_000, toPubkey: attacker.publicKey })],
    [payer],
    'fund attacker',
  )
  const roguePayout = new TransactionInstruction({
    data: Buffer.concat([disc('payout'), u64(10_000_000n)]),
    keys: [
      { isSigner: true, isWritable: false, pubkey: attacker.publicKey },
      { isSigner: false, isWritable: true, pubkey: statePda },
      { isSigner: false, isWritable: true, pubkey: vaultPda },
      { isSigner: false, isWritable: true, pubkey: member.publicKey },
      { isSigner: false, isWritable: false, pubkey: SystemProgram.programId },
    ],
    programId: PROGRAM_ID,
  })
  await trySend([roguePayout], [attacker], 'attacker payout')
  await trySend([payoutIx(attacker.publicKey, 10_000_000n)], [payer], 'payout → non-whitelisted')
  await trySend([payoutIx(member.publicKey, 600_000_000n)], [payer], 'payout over per-tx cap')

  const vaultSol = await conn.getBalance(vaultPda)
  const vaultTok = await conn.getTokenAccountBalance(vaultAtaA)
  console.log(`\nvault: ${vaultSol / 1e9} SOL | ${vaultTok.value.uiAmount} A-tokens\nDone.`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
