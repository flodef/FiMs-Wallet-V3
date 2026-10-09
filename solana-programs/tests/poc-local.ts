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
// A second member deliberately left OUT of the member_whitelist — used to
// prove deposit + issue_shares do not depend on whitelist membership.
const member2 = Keypair.fromSeed(createHash('sha256').update('fims-poc-member2').digest())
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
  // mintC is NOT strategy-critical — sweepable (yield / airdropped token).
  const mintC = Keypair.fromSeed(createHash('sha256').update('fims-poc-mintC').digest())
  const vaultAtaA = ataOf(vaultPda, mintA.publicKey)
  const vaultAtaB = ataOf(vaultPda, mintB.publicKey)
  const vaultAtaC = ataOf(vaultPda, mintC.publicKey)
  const memberAtaA = ataOf(member.publicKey, mintA.publicKey)
  const member2AtaA = ataOf(member2.publicKey, mintA.publicKey)
  const member2AtaB = ataOf(member2.publicKey, mintB.publicKey)
  const treasuryAtaA = ataOf(payer.publicKey, mintA.publicKey) // treasury=payer
  const treasuryAtaC = ataOf(payer.publicKey, mintC.publicKey)
  const attackerAtaA = ataOf(attacker.publicKey, mintA.publicKey)
  const attackerAtaB = ataOf(attacker.publicKey, mintB.publicKey)

  // 1. initialize — restricted to the program upgrade authority --------------
  // InitializeArgs: admin, delegate, guardian, treasury, allowed_programs,
  // member_whitelist, strategies, allowed_mint_pairs, daily_cap, tx_cap,
  // daily_token_cap
  const mintPair = Buffer.concat([
    mintA.publicKey.toBuffer(),
    mintB.publicKey.toBuffer(),
    Buffer.from([244, 1]),
    u64(1_000_000_000n),
  ])
  // A dummy strategy: collateral=mintA (stands in for JUPSOL), share=mintB
  // (stands in for FSOL). Fluid/Kamino program/pubkeys are never touched by
  // deposit/issue_shares, so placeholders are fine on localnet.
  const strategy = Buffer.concat([
    u64(52n), // vault_id
    u32(0), // position_id
    mintA.publicKey.toBuffer(), // vaults_program (placeholder)
    mintA.publicKey.toBuffer(), // position_nft_mint (placeholder)
    mintA.publicKey.toBuffer(), // collateral_mint = mintA
    mintB.publicKey.toBuffer(), // borrow_mint (placeholder)
    mintB.publicKey.toBuffer(), // stable_mint (placeholder)
    mintB.publicKey.toBuffer(), // share_mint = mintB
    u64(10_000_000_000n), // max_debt
  ])
  const initArgs = Buffer.concat([
    payer.publicKey.toBuffer(), // admin
    payer.publicKey.toBuffer(), // delegate
    guardian.publicKey.toBuffer(), // guardian
    payer.publicKey.toBuffer(), // treasury
    // Generic transfer programs (SPL token, system, ATA) are rejected by
    // validate_whitelists — a CPI through them has no protocol-side witness.
    borshVec([]),
    borshVec([member.publicKey.toBuffer(), payer.publicKey.toBuffer()]),
    borshVec([strategy]), // strategy 0: mintA collateral → mintB shares
    borshVec([mintPair]), // allowed_mint_pairs: A→B, 5% deviation bound + daily cap
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
        ...mintIx(mintC),
      ],
      [payer, mintA, mintB, mintC],
      'create mints A/B/C',
    )
    await send(
      [
        createAtaIx(payer.publicKey, vaultAtaA, vaultPda, mintA.publicKey),
        createAtaIx(payer.publicKey, vaultAtaC, vaultPda, mintC.publicKey),
        createAtaIx(payer.publicKey, treasuryAtaC, payer.publicKey, mintC.publicKey),
        createAtaIx(payer.publicKey, vaultAtaB, vaultPda, mintB.publicKey),
        createAtaIx(payer.publicKey, memberAtaA, member.publicKey, mintA.publicKey),
        createAtaIx(payer.publicKey, member2AtaA, member2.publicKey, mintA.publicKey),
        // member2AtaB deliberately NOT created — deposit() must create the
        // member's share ATA idempotently (member pays its own rent).
        createAtaIx(payer.publicKey, treasuryAtaA, payer.publicKey, mintA.publicKey),
        createAtaIx(payer.publicKey, attackerAtaA, attacker.publicKey, mintA.publicKey),
        createAtaIx(payer.publicKey, attackerAtaB, attacker.publicKey, mintB.publicKey),
        // 1000 mintA to vault + 200 mintA to member2 (deposit funds)
        // + 1000 mintB share supply to vault (stands in for the FSOL float)
        new TransactionInstruction({
          data: Buffer.concat([Buffer.from([7]), u64(1_000_000_000n)]),
          keys: [
            { isSigner: false, isWritable: true, pubkey: mintA.publicKey },
            { isSigner: false, isWritable: true, pubkey: vaultAtaA },
            { isSigner: true, isWritable: false, pubkey: payer.publicKey },
          ],
          programId: TOKEN_PROGRAM,
        }),
        new TransactionInstruction({
          data: Buffer.concat([Buffer.from([7]), u64(200_000_000n)]),
          keys: [
            { isSigner: false, isWritable: true, pubkey: mintA.publicKey },
            { isSigner: false, isWritable: true, pubkey: member2AtaA },
            { isSigner: true, isWritable: false, pubkey: payer.publicKey },
          ],
          programId: TOKEN_PROGRAM,
        }),
        new TransactionInstruction({
          data: Buffer.concat([Buffer.from([7]), u64(1_000_000_000n)]),
          keys: [
            { isSigner: false, isWritable: true, pubkey: mintB.publicKey },
            { isSigner: false, isWritable: true, pubkey: vaultAtaB },
            { isSigner: true, isWritable: false, pubkey: payer.publicKey },
          ],
          programId: TOKEN_PROGRAM,
        }),
        // 1000 mintC to vault — the sweepable yield token
        new TransactionInstruction({
          data: Buffer.concat([Buffer.from([7]), u64(1_000_000_000n)]),
          keys: [
            { isSigner: false, isWritable: true, pubkey: mintC.publicKey },
            { isSigner: false, isWritable: true, pubkey: vaultAtaC },
            { isSigner: true, isWritable: false, pubkey: payer.publicKey },
          ],
          programId: TOKEN_PROGRAM,
        }),
      ],
      [payer],
      'create ATAs + fund vault mint balances',
    )
    // member2 pays its own deposit tx fee + member_deposit PDA rent
    await send(
      [SystemProgram.transfer({ fromPubkey: payer.publicKey, lamports: 20_000_000, toPubkey: member2.publicKey })],
      [payer],
      'fund member2 (fees + PDA rent)',
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
        { isSigner: false, isWritable: false, pubkey: mintA.publicKey }, // mint_info
      ],
      programId: PROGRAM_ID,
    })
  await send([payoutTokenIx(memberAtaA, 100_000_000n)], [payer], 'payout_token 100 → member ATA')
  await trySend([payoutTokenIx(attackerAtaA, 100_000_000n)], [payer], 'payout_token → attacker ATA')
  await trySend([payoutTokenIx(memberAtaA, 500_000_000n)], [payer], 'payout_token over token cap')

  // 5. sweep → treasury only, yield mints only, token-cap bound --------------
  const sweepIx = (mint: PublicKey, source: PublicKey, dest: PublicKey, amount: bigint) =>
    new TransactionInstruction({
      data: Buffer.concat([disc('sweep'), mint.toBuffer(), u64(amount)]),
      keys: [
        { isSigner: true, isWritable: false, pubkey: payer.publicKey },
        { isSigner: false, isWritable: true, pubkey: statePda },
        { isSigner: false, isWritable: true, pubkey: vaultPda },
        { isSigner: false, isWritable: true, pubkey: source },
        { isSigner: false, isWritable: true, pubkey: dest },
        { isSigner: false, isWritable: false, pubkey: TOKEN_PROGRAM },
        { isSigner: false, isWritable: false, pubkey: mint }, // mint_info
      ],
      programId: PROGRAM_ID,
    })
  await send([sweepIx(mintC.publicKey, vaultAtaC, treasuryAtaC, 50_000_000n)], [payer], 'sweep 50 mintC → treasury ATA')
  await trySend(
    [sweepIx(mintA.publicKey, vaultAtaA, treasuryAtaA, 50_000_000n)],
    [payer],
    'sweep collateral mint (strategy asset)',
  )
  await trySend(
    [sweepIx(mintB.publicKey, vaultAtaB, ataOf(payer.publicKey, mintB.publicKey), 50_000_000n)],
    [payer],
    'sweep share mint (strategy asset)',
  )
  await trySend(
    [sweepIx(mintC.publicKey, vaultAtaC, memberAtaA, 50_000_000n)],
    [payer],
    'sweep → member ATA (wrong dest)',
  )
  await trySend([sweepIx(mintC.publicKey, vaultAtaC, treasuryAtaC, 500_000_000n)], [payer], 'sweep over token cap')

  // 5b. member deposit → issue_shares (1:1 guarantee, no whitelist needed) ----
  // member2 is NOT in member_whitelist — deposit is permissionless and
  // issue_shares pays the depositor's own ATA derived from member_deposit.
  const member2DepositPda = PublicKey.findProgramAddressSync(
    [Buffer.from('deposit'), member2.publicKey.toBuffer(), Buffer.from([0])],
    PROGRAM_ID,
  )[0]
  const depositIx = (amount: bigint, tip: bigint, shareProgram = TOKEN_PROGRAM) =>
    new TransactionInstruction({
      data: Buffer.concat([disc('deposit'), Buffer.from([0]), u64(amount), u64(tip)]),
      keys: [
        { isSigner: true, isWritable: true, pubkey: member2.publicKey },
        { isSigner: false, isWritable: false, pubkey: statePda },
        { isSigner: false, isWritable: true, pubkey: member2AtaA },
        { isSigner: false, isWritable: true, pubkey: vaultPda },
        { isSigner: false, isWritable: true, pubkey: vaultAtaA },
        { isSigner: false, isWritable: true, pubkey: payer.publicKey }, // delegate
        { isSigner: false, isWritable: false, pubkey: mintB.publicKey }, // share_mint
        { isSigner: false, isWritable: true, pubkey: member2AtaB }, // member share ATA (created by deposit)
        { isSigner: false, isWritable: true, pubkey: member2DepositPda },
        { isSigner: false, isWritable: false, pubkey: TOKEN_PROGRAM }, // collateral token_program
        { isSigner: false, isWritable: false, pubkey: shareProgram }, // share_token_program
        { isSigner: false, isWritable: false, pubkey: SystemProgram.programId },
        { isSigner: false, isWritable: false, pubkey: ATA_PROGRAM },
        { isSigner: false, isWritable: false, pubkey: mintA.publicKey }, // collateral_mint
      ],
      programId: PROGRAM_ID,
    })
  await send([depositIx(200_000_000n, 500_000n)], [member2], 'member2 deposit 200 mintA + 0.0005 tip')
  const depAcct = await conn.getAccountInfo(member2DepositPda)
  const pending = depAcct ? depAcct.data.readBigUInt64LE(41) : 0n
  console.log(`  member_deposit.pending = ${pending} (expect 200000000)`)

  const issueIx = (
    caller: PublicKey,
    source: PublicKey,
    dest: PublicKey,
    amount: bigint,
    depositPda = member2DepositPda,
  ) =>
    new TransactionInstruction({
      data: Buffer.concat([disc('issue_shares'), u64(amount)]),
      keys: [
        { isSigner: true, isWritable: false, pubkey: caller },
        { isSigner: false, isWritable: false, pubkey: statePda },
        { isSigner: false, isWritable: true, pubkey: vaultPda },
        { isSigner: false, isWritable: true, pubkey: depositPda },
        { isSigner: false, isWritable: true, pubkey: source },
        { isSigner: false, isWritable: true, pubkey: dest },
        { isSigner: false, isWritable: false, pubkey: TOKEN_PROGRAM },
        { isSigner: false, isWritable: false, pubkey: mintB.publicKey }, // share_mint
      ],
      programId: PROGRAM_ID,
    })
  // Whitelist bypass proof: a straight payout_token to member2's share ATA
  // must fail (not whitelisted) while issue_shares to the same ATA works.
  const payoutTokenB = (dest: PublicKey, amount: bigint) =>
    new TransactionInstruction({
      data: Buffer.concat([disc('payout_token'), mintB.publicKey.toBuffer(), u64(amount)]),
      keys: [
        { isSigner: true, isWritable: false, pubkey: payer.publicKey },
        { isSigner: false, isWritable: true, pubkey: statePda },
        { isSigner: false, isWritable: true, pubkey: vaultPda },
        { isSigner: false, isWritable: true, pubkey: vaultAtaB },
        { isSigner: false, isWritable: true, pubkey: dest },
        { isSigner: false, isWritable: false, pubkey: TOKEN_PROGRAM },
        { isSigner: false, isWritable: false, pubkey: mintB.publicKey }, // mint_info
      ],
      programId: PROGRAM_ID,
    })
  await trySend([payoutTokenB(member2AtaB, 1_000_000n)], [payer], 'payout_token mintB → non-whitelisted member2')
  await trySend(
    [issueIx(member2.publicKey, vaultAtaB, member2AtaB, 100_000_000n)],
    [member2],
    'issue_shares by non-delegate',
  )
  await trySend(
    [issueIx(payer.publicKey, vaultAtaB, member2AtaB, 500_000_000n)],
    [payer],
    'issue_shares over pending (500>200)',
  )
  await trySend([issueIx(payer.publicKey, vaultAtaB, attackerAtaB, 100_000_000n)], [payer], 'issue_shares → wrong ATA')
  await send(
    [issueIx(payer.publicKey, vaultAtaB, member2AtaB, 200_000_000n)],
    [payer],
    'issue_shares 200 mintB → member2',
  )
  await trySend(
    [issueIx(payer.publicKey, vaultAtaB, member2AtaB, 1_000_000n)],
    [payer],
    'issue_shares replay (pending=0)',
  )
  await trySend([depositIx(1_000_000n, 20_000_000n)], [member2], 'deposit with tip over cap')
  await trySend([depositIx(1_000_000n, 100_000n)], [member2], 'deposit with tip under min (free-riding)')

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

  // guardian veto: a scheduled config change can be canceled inside the
  // timelock — apply then fails with NothingPending.
  await send(
    [
      new TransactionInstruction({
        data: Buffer.concat([disc('schedule_config'), cfgArgs]),
        keys: stateKeys(payer.publicKey, true),
        programId: PROGRAM_ID,
      }),
    ],
    [payer],
    'schedule_config (veto target)',
  )
  await send(
    [
      new TransactionInstruction({
        data: disc('guardian_cancel_pending'),
        keys: stateKeys(guardian.publicKey, true),
        programId: PROGRAM_ID,
      }),
    ],
    [guardian],
    'guardian_cancel_pending (veto)',
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
    'apply_config after guardian veto',
  )

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

  // ---- adversarial regressions (external-audit pass) -------------------------
  // The instant set_delegate path is gone — rotation is a timelocked config
  // change (variant index 3). Scheduling overwrites the earlier pending
  // MemberWhitelist change, which also proves a pending entry is replaceable.
  await trySend(
    [
      new TransactionInstruction({
        data: Buffer.concat([disc('set_delegate'), attacker.publicKey.toBuffer()]),
        keys: stateKeys(payer.publicKey, true),
        programId: PROGRAM_ID,
      }),
    ],
    [payer],
    'instant set_delegate removed',
  )
  const delegateCfg = Buffer.concat([Buffer.from([3]), attacker.publicKey.toBuffer()])
  await send(
    [
      new TransactionInstruction({
        data: Buffer.concat([disc('schedule_config'), delegateCfg]),
        keys: stateKeys(payer.publicKey, true),
        programId: PROGRAM_ID,
      }),
    ],
    [payer],
    'schedule_config (Delegate rotation)',
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
    'apply_config delegate before timelock',
  )
  // A deposit built by a hostile client pointing share_token_program at the
  // system program must be rejected — the program is resolved from the mint.
  await trySend(
    [depositIx(1_000_000n, 500_000n, SystemProgram.programId)],
    [member2],
    'deposit wrong share_token_program',
  )
  // issue_shares against a member_deposit PDA that was never initialized.
  const attackerDepositPda = PublicKey.findProgramAddressSync(
    [Buffer.from('deposit'), attacker.publicKey.toBuffer(), Buffer.from([0])],
    PROGRAM_ID,
  )[0]
  await trySend(
    [issueIx(payer.publicKey, vaultAtaB, attackerAtaB, 1_000_000n, attackerDepositPda)],
    [payer],
    'issue_shares → uninitialized deposit PDA',
  )
  // The vault itself is not a payout destination.
  await trySend([payoutIx(vaultPda, 10_000_000n)], [payer], 'payout → vault itself')

  const vaultSol = await conn.getBalance(vaultPda)
  const vaultTok = await conn.getTokenAccountBalance(vaultAtaA)
  console.log(`\nvault: ${vaultSol / 1e9} SOL | ${vaultTok.value.uiAmount} A-tokens\nDone.`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
