import {
  createWalletClient,
  createPublicClient,
  http,
  parseAbi,
  encodeFunctionData,
} from "viem";
import { base, baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  getAccount,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import bs58 from "bs58";
import {
  BASE_TOKEN_MESSENGER,
  BASE_MESSAGE_TRANSMITTER,
  SEPOLIA_TOKEN_MESSENGER,
  SEPOLIA_MESSAGE_TRANSMITTER,
  USDC_BASE,
  USDC_BASE_SEPOLIA,
  USDC_SOLANA,
  DOMAIN_SOLANA,
  DOMAIN_BASE,
  CIRCLE_IRIS_API,
  MESSAGE_TRANSMITTER_ABI,
  TOKEN_MESSENGER_V2_ABI,
  SOLANA_TOKEN_MESSENGER_PROGRAM,
  SOLANA_MESSAGE_TRANSMITTER_PROGRAM,
  FINALITY_THRESHOLD_CONFIRMED,
} from "./constants.js";

// ── Anchor instruction discriminators (sha256("global:<name>")[:8]) ──────────
// Same between V1 and V2 Solana programs (derived from instruction name only)
// global:deposit_for_burn  → [0xd7, 0x3c, 0x3d, 0x2e, 0x72, 0x37, 0x80, 0xb0]
// global:receive_message   → [0x26, 0x90, 0x7f, 0xe1, 0x1f, 0xe1, 0xee, 0x19]
const DISC_DEPOSIT_FOR_BURN = Buffer.from([0xd7, 0x3c, 0x3d, 0x2e, 0x72, 0x37, 0x80, 0xb0]);
const DISC_RECEIVE_MESSAGE  = Buffer.from([0x26, 0x90, 0x7f, 0xe1, 0x1f, 0xe1, 0xee, 0x19]);

// Well-known Solana program IDs
const SPL_TOKEN_PROGRAM  = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const SYSTEM_PROGRAM     = SystemProgram.programId;

// CCTP nonces bucket size (same for V1 and V2)
const NONCES_PER_ACCOUNT = 6400n;

// ── Env helpers ───────────────────────────────────────────────────────────────

function isMockMode(): boolean {
  return process.env["CCTP_MOCK"] === "true";
}

function isTestnet(): boolean {
  return process.env["CCTP_TESTNET"] === "true";
}

function getSolanaRpc(): string {
  return process.env["SOLANA_RPC_URL"] ?? "https://api.mainnet-beta.solana.com";
}

function getBaseRpc(): string {
  return process.env["BASE_MAINNET_RPC_URL"] ?? "https://mainnet.base.org";
}

function getBaseSepoliaRpc(): string {
  return process.env["BASE_SEPOLIA_RPC_URL"] ?? "https://sepolia.base.org";
}

function getSolanaRelayerKeypair(): Keypair {
  const key = process.env["SOLANA_RELAYER_KEY"];
  if (!key) throw new Error("SOLANA_RELAYER_KEY not set — required for CCTP Solana operations");
  return Keypair.fromSecretKey(bs58.decode(key));
}

// ── ATA helper (internal shorthand) ───────────────────────────────────────────

function ataFor(wallet: PublicKey, mint: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, wallet, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
}

/** Convert Solana public key to bytes32 (left-zero-padded) for CCTP depositForBurn. */
function solanaKeyToBytes32(publicKey: string): `0x${string}` {
  const bytes = new PublicKey(publicKey).toBytes();
  return `0x${Buffer.from(bytes).toString("hex").padStart(64, "0")}`;
}

// bytes32 zero — used as destinationCaller (any relayer can relay)
const BYTES32_ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

// ── Circle Iris API V2 attestation polling ─────────────────────────────────────
//
// V2 API: GET /v2/messages/{sourceDomain}?transactionHash={txHash}
//   Returns: { messages: [{ message, attestation, status, delayReason, destinationTxHash }] }
//
// Strategy: CONFIRMED (1000) + maxFee=1.5 USDC → Circle auto-relays to Solana.
//   - Circle submits receiveMessage on Solana on our behalf
//   - status="complete" means USDC is already minted on Solana
//   - No Solana keypair or tx-building code needed on our side
//   - Fee: ~1.3 USDC deducted from transfer amount

interface V2AttestationResult {
  message: string;      // raw message hex (0x-prefixed)
  attestation: string;  // attestation hex (0x-prefixed)
  destTxHash?: string;  // Solana/dest tx hash if Circle auto-relayed (status=complete)
}

async function pollAttestationV2(
  sourceDomain: number,
  txHash: string,
  maxWaitMs = 900_000,
): Promise<V2AttestationResult> {
  const start = Date.now();
  const url = `${CIRCLE_IRIS_API}/v2/messages/${sourceDomain}?transactionHash=${txHash}`;
  console.log(`[cctp-v2] polling iris: ${url}`);

  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) {
        const data = await res.json() as {
          messages?: Array<{
            message?: string;
            attestation?: string;
            status?: string;
            delayReason?: string;
            destinationTxHash?: string;
          }>;
        };
        const msg = data.messages?.[0];
        if (msg) {
          const status = msg.status ?? "unknown";
          const delay = msg.delayReason ? ` delay=${msg.delayReason}` : "";
          console.log(`[cctp-v2] status=${status}${delay} elapsed=${Math.round((Date.now() - start) / 1000)}s`);
          if (status === "complete") {
            console.log(`[cctp-v2] complete after ${Math.round((Date.now() - start) / 1000)}s`);
            return {
              message: (msg.message ?? "").startsWith("0x") ? (msg.message ?? "") : `0x${msg.message ?? ""}`,
              attestation: (msg.attestation ?? "").startsWith("0x") ? (msg.attestation ?? "") : `0x${msg.attestation ?? ""}`,
              destTxHash: msg.destinationTxHash,
            };
          }
        } else {
          console.log(`[cctp-v2] no messages yet (${Math.round((Date.now() - start) / 1000)}s elapsed)`);
        }
      } else {
        console.log(`[cctp-v2] iris HTTP ${res.status} — retrying`);
      }
    } catch {
      // transient network error — keep polling
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`CCTP V2 attestation timeout after ${maxWaitMs}ms (txHash=${txHash})`);
}

// ── Solana PDA helpers (same seeds for V1 and V2 programs) ────────────────────

function messageTransmitterPdas(
  sourceDomain: number,
  nonce: bigint,
  tokenMessengerProgram: PublicKey,
  messageTransmitterProgram: PublicKey,
) {
  const firstNonce = (((nonce - 1n) / NONCES_PER_ACCOUNT) * NONCES_PER_ACCOUNT + 1n);

  const [authorityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("message_transmitter_authority"), tokenMessengerProgram.toBuffer()],
    messageTransmitterProgram,
  );
  const [messageTransmitterAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("message_transmitter")],
    messageTransmitterProgram,
  );
  const [usedNonces] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("used_nonces"),
      Buffer.from(sourceDomain.toString()),   // UTF-8, not LE bytes
      Buffer.from(firstNonce.toString()),
    ],
    messageTransmitterProgram,
  );
  const [eventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    messageTransmitterProgram,
  );
  return { authorityPda, messageTransmitterAccount, usedNonces, eventAuthority };
}

function tokenMessengerPdas(
  sourceDomain: number,
  burnTokenBytes32: Buffer,
  usdcMint: PublicKey,
  tokenMessengerProgram: PublicKey,
) {
  const srcDomainStr = Buffer.from(sourceDomain.toString());

  const [tokenMessenger] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_messenger")],
    tokenMessengerProgram,
  );
  const [remoteTokenMessenger] = PublicKey.findProgramAddressSync(
    [Buffer.from("remote_token_messenger"), srcDomainStr],
    tokenMessengerProgram,
  );
  const [tokenMinter] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_minter")],
    tokenMessengerProgram,
  );
  const [localToken] = PublicKey.findProgramAddressSync(
    [Buffer.from("local_token"), usdcMint.toBuffer()],
    tokenMessengerProgram,
  );
  const [tokenPair] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_pair"), srcDomainStr, burnTokenBytes32],
    tokenMessengerProgram,
  );
  const [custodyTokenAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("custody"), usdcMint.toBuffer()],
    tokenMessengerProgram,
  );
  const [tokenMessengerEventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    tokenMessengerProgram,
  );
  return {
    tokenMessenger,
    remoteTokenMessenger,
    tokenMinter,
    localToken,
    tokenPair,
    custodyTokenAccount,
    tokenMessengerEventAuthority,
  };
}

// ── CCTP V2 message parsing ────────────────────────────────────────────────────
//
// V2 message layout (from BurnMessageV2):
//   header: version(4) | sourceDomain(4) | destDomain(4) | nonce(8) |
//           sender(32) | recipient(32) | destCaller(32) | minFinalityThreshold(4) = 120 bytes
//   body:   version(4) | burnToken(32) | mintRecipient(32) | amount(32) | messageSender(32) | maxFee(32) | feeExecuted(32)
//
// V1 header was 116 bytes; V2 header is 120 bytes (added 4 bytes for minFinalityThreshold).

interface CctpV2MessageFields {
  sourceDomain: number;
  nonce: bigint;
  burnToken: Buffer;    // bytes32
  mintRecipient: Buffer; // bytes32
}

function parseCctpV2Message(hexMessage: string): CctpV2MessageFields {
  const msg = Buffer.from(hexMessage.replace("0x", ""), "hex");
  const sourceDomain = msg.readUInt32BE(4);
  const nonce = msg.readBigUInt64BE(12);
  // V2 header = 120 bytes; body starts at 120
  const bodyOffset = 120;
  const burnToken    = msg.slice(bodyOffset + 4,      bodyOffset + 4 + 32);
  const mintRecipient = msg.slice(bodyOffset + 4 + 32, bodyOffset + 4 + 64);
  return { sourceDomain, nonce, burnToken, mintRecipient };
}

// ── receiveOnSolana (V2 programs) ─────────────────────────────────────────────

async function receiveOnSolana(message: string, attestation: string): Promise<string> {
  const connection = new Connection(getSolanaRpc(), "confirmed");
  const relayer = getSolanaRelayerKeypair();

  const fields = parseCctpV2Message(message);
  const usdcMint = new PublicKey(USDC_SOLANA);
  const tokenMessengerProgram   = new PublicKey(SOLANA_TOKEN_MESSENGER_PROGRAM);
  const messageTransmitterProgram = new PublicKey(SOLANA_MESSAGE_TRANSMITTER_PROGRAM);

  const { authorityPda, messageTransmitterAccount, usedNonces, eventAuthority } =
    messageTransmitterPdas(fields.sourceDomain, fields.nonce, tokenMessengerProgram, messageTransmitterProgram);

  const { tokenMessenger, remoteTokenMessenger, tokenMinter, localToken, tokenPair, custodyTokenAccount, tokenMessengerEventAuthority } =
    tokenMessengerPdas(fields.sourceDomain, fields.burnToken, usdcMint, tokenMessengerProgram);

  // mintRecipient is the ATA address itself (set by bridgeToSolana — see comment there)
  const recipientTokenAccount = new PublicKey(fields.mintRecipient);

  const msgBytes = Buffer.from(message.replace("0x", ""), "hex");
  const attBytes = Buffer.from(attestation.replace("0x", ""), "hex");
  const msgLen = Buffer.alloc(4); msgLen.writeUInt32LE(msgBytes.length);
  const attLen = Buffer.alloc(4); attLen.writeUInt32LE(attBytes.length);
  const data = Buffer.concat([DISC_RECEIVE_MESSAGE, msgLen, msgBytes, attLen, attBytes]);

  const ix = new TransactionInstruction({
    programId: messageTransmitterProgram,
    keys: [
      { pubkey: relayer.publicKey,            isSigner: true,  isWritable: true  },
      { pubkey: relayer.publicKey,            isSigner: true,  isWritable: false },
      { pubkey: authorityPda,                 isSigner: false, isWritable: false },
      { pubkey: messageTransmitterAccount,    isSigner: false, isWritable: true  },
      { pubkey: usedNonces,                   isSigner: false, isWritable: true  },
      { pubkey: tokenMessengerProgram,        isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM,               isSigner: false, isWritable: false },
      { pubkey: eventAuthority,               isSigner: false, isWritable: false },
      { pubkey: messageTransmitterProgram,    isSigner: false, isWritable: false },
      // TokenMessengerMinterV2 CPI accounts
      { pubkey: tokenMessenger,               isSigner: false, isWritable: false },
      { pubkey: remoteTokenMessenger,         isSigner: false, isWritable: false },
      { pubkey: tokenMinter,                  isSigner: false, isWritable: false },
      { pubkey: localToken,                   isSigner: false, isWritable: true  },
      { pubkey: tokenPair,                    isSigner: false, isWritable: false },
      { pubkey: recipientTokenAccount,        isSigner: false, isWritable: true  },
      { pubkey: custodyTokenAccount,          isSigner: false, isWritable: true  },
      { pubkey: SPL_TOKEN_PROGRAM,            isSigner: false, isWritable: false },
      { pubkey: tokenMessengerEventAuthority, isSigner: false, isWritable: false },
      { pubkey: tokenMessengerProgram,        isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction();
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = relayer.publicKey;
  tx.add(ix);
  tx.sign(relayer);

  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}

// ── Public: Base → Solana ──────────────────────────────────────────────────────

export interface BridgeToSolanaParams {
  /** USDC amount in 6-decimal units */
  amount: bigint;
  /** Solana wallet address that will receive USDC */
  destSolanaPublicKey: string;
  /** Base EOA private key (0x-prefixed) — source of USDC */
  relayerPrivateKey: string;
}

export interface BridgeResult {
  sourceTxHash: string;
  destTxHash: string;
  bridgeTimeMs: number;
}

// Circle CCTP V2 auto-relay fee for Base→Solana CONFIRMED tier
// Circle charges ~1.3 USDC; we authorize up to 1.5 USDC as maxFee buffer
const CIRCLE_RELAY_MAX_FEE = 1_500_000n; // 1.5 USDC (6 decimals)

/**
 * Bridge native USDC from Base → Solana via Circle CCTP V2 with auto-relay.
 *
 * Strategy: CONFIRMED (1000) + maxFee=1.5 USDC → Circle auto-relays.
 *   - Circle submits receiveMessage on Solana automatically
 *   - status="complete" in iris means USDC is minted on Solana — no Solana code needed
 *   - Fee: ~1.3 USDC deducted from transfer amount on destination
 *
 * Steps:
 *   1. Approve TokenMessengerV2 for USDC spend
 *   2. depositForBurn on Base (CONFIRMED + maxFee=1.5 USDC)
 *   3. Poll iris until status=complete (Circle relayed to Solana)
 */
export async function bridgeToSolana(params: BridgeToSolanaParams): Promise<BridgeResult> {
  if (isMockMode()) {
    return {
      sourceTxHash: `MOCK_BASE_TX_${Date.now()}`,
      destTxHash:   `MOCK_SOL_TX_${Date.now()}`,
      bridgeTimeMs: 100,
    };
  }

  const start    = Date.now();
  const testnet  = isTestnet();
  const chain    = testnet ? baseSepolia : base;
  const rpc      = testnet ? getBaseSepoliaRpc() : getBaseRpc();
  const tokenMessengerAddr = testnet ? SEPOLIA_TOKEN_MESSENGER : BASE_TOKEN_MESSENGER;
  const usdcAddress        = testnet ? USDC_BASE_SEPOLIA : USDC_BASE;

  const account      = privateKeyToAccount(params.relayerPrivateKey as `0x${string}`);
  const walletClient = createWalletClient({ account, chain, transport: http(rpc) });
  const publicClient = createPublicClient({ chain, transport: http(rpc) });

  console.log(`[cctp-v2] bridgeToSolana: account=${account.address} amount=${params.amount} dest=${params.destSolanaPublicKey}`);
  console.log(`[cctp-v2] strategy: CONFIRMED (1000) + maxFee=1.5 USDC → Circle auto-relay`);

  // 0. Ensure buyer's USDC ATA exists on Solana BEFORE Circle mints to it.
  //    CCTP V2 mintRecipient must be the token account (ATA), not the wallet.
  //    Circle's receiveMessage will mint to this exact address — it must pre-exist.
  const solanaConn = new Connection(getSolanaRpc(), "confirmed");
  const solanaRelayer = getSolanaRelayerKeypair();
  const destWalletPubkey = new PublicKey(params.destSolanaPublicKey);
  const usdcSolanaMint = new PublicKey(USDC_SOLANA);
  const destUsdcAta = ataFor(destWalletPubkey, usdcSolanaMint);
  try {
    await getAccount(solanaConn, destUsdcAta, "confirmed", TOKEN_PROGRAM_ID);
    console.log(`[cctp-v2] buyer USDC ATA exists: ${destUsdcAta.toBase58()}`);
  } catch {
    console.log(`[cctp-v2] creating buyer USDC ATA: ${destUsdcAta.toBase58()}`);
    const createAtaTx = new Transaction();
    const { blockhash: ataBh, lastValidBlockHeight: ataLvbh } = await solanaConn.getLatestBlockhash();
    createAtaTx.recentBlockhash = ataBh;
    createAtaTx.feePayer = solanaRelayer.publicKey;
    createAtaTx.add(
      createAssociatedTokenAccountInstruction(
        solanaRelayer.publicKey,
        destUsdcAta,
        destWalletPubkey,
        usdcSolanaMint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
    createAtaTx.sign(solanaRelayer);
    const ataSig = await solanaConn.sendRawTransaction(createAtaTx.serialize(), { skipPreflight: false });
    await solanaConn.confirmTransaction(
      { signature: ataSig, blockhash: ataBh, lastValidBlockHeight: ataLvbh },
      "confirmed",
    );
    console.log(`[cctp-v2] USDC ATA created: ${ataSig}`);
  }

  // 1. Approve V2 TokenMessengerV2 — check existing allowance first
  const existingAllowance = await publicClient.readContract({
    address: usdcAddress,
    abi: parseAbi(["function allowance(address owner, address spender) view returns (uint256)"]),
    functionName: "allowance",
    args: [account.address, tokenMessengerAddr],
  });
  console.log(`[cctp-v2] step1: allowance=${existingAllowance} needed=${params.amount}`);
  if (existingAllowance < params.amount) {
    const approveData = encodeFunctionData({
      abi: parseAbi(["function approve(address,uint256) returns (bool)"]),
      functionName: "approve",
      args: [tokenMessengerAddr, params.amount],
    });
    const approveTx = await walletClient.sendTransaction({
      to: usdcAddress,
      data: approveData,
      gas: 100_000n,
    });
    console.log(`[cctp-v2] approve tx: ${approveTx}`);
    await publicClient.waitForTransactionReceipt({ hash: approveTx, timeout: 60_000 });
    console.log(`[cctp-v2] approve confirmed`);
  } else {
    console.log(`[cctp-v2] approve skipped — allowance sufficient`);
  }

  // 2. depositForBurn — CONFIRMED (1000) + maxFee=1.5 USDC
  //    Circle auto-relays to Solana when fee >= minimumFee (~1.3 USDC for Base→Solana)
  //    mintRecipient = USDC ATA (token account, not wallet) — Circle mints directly to this
  const mintRecipientBytes32 = solanaKeyToBytes32(destUsdcAta.toBase58());
  // Fetch pending nonce explicitly to avoid stale nonce after approve
  const depositNonce = await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });
  console.log(`[cctp-v2] step2: depositForBurn amount=${params.amount} maxFee=${CIRCLE_RELAY_MAX_FEE} finality=1000 nonce=${depositNonce}`);

  const burnTxHash = await walletClient.writeContract({
    address: tokenMessengerAddr,
    abi: TOKEN_MESSENGER_V2_ABI,
    functionName: "depositForBurn",
    args: [
      params.amount,
      DOMAIN_SOLANA,
      mintRecipientBytes32 as `0x${string}`,
      usdcAddress,
      BYTES32_ZERO,               // destinationCaller: anyone (Circle) can relay
      CIRCLE_RELAY_MAX_FEE,       // maxFee: 1.5 USDC — Circle charges ~1.3 USDC
      FINALITY_THRESHOLD_CONFIRMED as number, // 1000 (CONFIRMED) — Circle auto-relay tier
    ],
    gas: 250_000n,
    nonce: depositNonce,
  });
  console.log(`[cctp-v2] depositForBurn tx: ${burnTxHash}`);
  await publicClient.waitForTransactionReceipt({ hash: burnTxHash, timeout: 120_000 });
  console.log(`[cctp-v2] depositForBurn confirmed`);

  // 3. Poll iris until status=complete
  //    "complete" = Circle has submitted and confirmed receiveMessage on Solana
  console.log(`[cctp-v2] step3: waiting for Circle relay (iris status=complete)...`);
  const { destTxHash: circleDestTx } = await pollAttestationV2(DOMAIN_BASE, burnTxHash, 900_000);
  const destTxHash = circleDestTx ?? "circle-auto-relayed";
  console.log(`[cctp-v2] Circle relay complete! Solana tx: ${destTxHash}`);

  return { sourceTxHash: burnTxHash, destTxHash, bridgeTimeMs: Date.now() - start };
}

// ── Public: Solana → Base ──────────────────────────────────────────────────────

export interface BridgeToBaseParams {
  /** USDC amount in 6-decimal units */
  amount: bigint;
  /** Base address to receive USDC */
  destBaseAddress: string;
  /** Solana keypair that owns the USDC (source of burn) */
  solanaKeypair: Keypair;
  /** Base EOA private key (0x-prefixed) — submits receiveMessage on Base */
  relayerPrivateKey: string;
}

/**
 * Bridge native USDC from Solana → Base via Circle CCTP V2.
 *
 * Steps:
 *   1. depositForBurn on Solana V2 (TokenMessengerMinterV2)
 *   2. Poll Circle V2 attestation API
 *   3. receiveMessage on Base V2 (MessageTransmitterV2)
 */
export async function bridgeToBase(params: BridgeToBaseParams): Promise<BridgeResult> {
  if (isMockMode()) {
    return {
      sourceTxHash: `MOCK_SOL_TX_${Date.now()}`,
      destTxHash:   `MOCK_BASE_TX_${Date.now()}`,
      bridgeTimeMs: 100,
    };
  }

  const start     = Date.now();
  const connection = new Connection(getSolanaRpc(), "confirmed");
  const usdcMint   = new PublicKey(USDC_SOLANA);
  const tokenMessengerProgram    = new PublicKey(SOLANA_TOKEN_MESSENGER_PROGRAM);
  const messageTransmitterProgram = new PublicKey(SOLANA_MESSAGE_TRANSMITTER_PROGRAM);

  console.log(`[cctp-v2] bridgeToBase: dest=${params.destBaseAddress} amount=${params.amount}`);
  console.log(`[cctp-v2] using Solana V2 programs: ${SOLANA_TOKEN_MESSENGER_PROGRAM}`);

  // ── 1. depositForBurn on Solana V2 ──────────────────────────────────────────

  const destDomainBuf = Buffer.alloc(4);
  destDomainBuf.writeUInt32LE(DOMAIN_BASE);

  // Base address right-aligned in bytes32
  const destBytes32 = Buffer.alloc(32);
  Buffer.from(params.destBaseAddress.replace("0x", ""), "hex").copy(destBytes32, 12);

  // V2 adds: destinationCaller(32) + maxFee(8 u64 LE) + minFinalityThreshold(4 u32 LE)
  const destinationCaller = Buffer.alloc(32); // bytes32(0) — anyone can relay
  const maxFeeBuf = Buffer.alloc(8);          // 0n — FINALIZED tier, no fee
  const finalityBuf = Buffer.alloc(4);
  finalityBuf.writeUInt32LE(FINALITY_THRESHOLD_CONFIRMED); // 1000 (CONFIRMED, Circle relay)

  const [senderAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("sender_authority")],
    tokenMessengerProgram,
  );
  const [messageTransmitterAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("message_transmitter")],
    messageTransmitterProgram,
  );
  const [tokenMessenger] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_messenger")],
    tokenMessengerProgram,
  );
  const [remoteTokenMessenger] = PublicKey.findProgramAddressSync(
    [Buffer.from("remote_token_messenger"), Buffer.from(DOMAIN_BASE.toString())],
    tokenMessengerProgram,
  );
  const [tokenMinter] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_minter")],
    tokenMessengerProgram,
  );
  const [localToken] = PublicKey.findProgramAddressSync(
    [Buffer.from("local_token"), usdcMint.toBuffer()],
    tokenMessengerProgram,
  );
  const [eventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    tokenMessengerProgram,
  );

  const burnTokenAccount     = ataFor(params.solanaKeypair.publicKey, usdcMint);
  const messageSentEventData = Keypair.generate();

  // V2 Borsh layout: disc(8) + amount u64(8) + destDomain u32(4) + mintRecipient [u8;32]
  //                  + destinationCaller [u8;32] + maxFee u64(8) + minFinalityThreshold u32(4)
  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64LE(params.amount);
  const burnData = Buffer.concat([
    DISC_DEPOSIT_FOR_BURN,
    amountBuf,
    destDomainBuf,
    destBytes32,
    destinationCaller,
    maxFeeBuf,
    finalityBuf,
  ]);

  const burnIx = new TransactionInstruction({
    programId: tokenMessengerProgram,
    keys: [
      { pubkey: params.solanaKeypair.publicKey, isSigner: true,  isWritable: true  },
      { pubkey: eventAuthority,                 isSigner: false, isWritable: false },
      { pubkey: tokenMessengerProgram,          isSigner: false, isWritable: false },
      { pubkey: senderAuthority,                isSigner: false, isWritable: false },
      { pubkey: burnTokenAccount,               isSigner: false, isWritable: true  },
      { pubkey: messageTransmitterAccount,      isSigner: false, isWritable: true  },
      { pubkey: tokenMessenger,                 isSigner: false, isWritable: false },
      { pubkey: remoteTokenMessenger,           isSigner: false, isWritable: false },
      { pubkey: tokenMinter,                    isSigner: false, isWritable: false },
      { pubkey: localToken,                     isSigner: false, isWritable: true  },
      { pubkey: usdcMint,                       isSigner: false, isWritable: true  },
      { pubkey: messageSentEventData.publicKey, isSigner: true,  isWritable: true  },
      { pubkey: messageTransmitterProgram,      isSigner: false, isWritable: false },
      { pubkey: tokenMessengerProgram,          isSigner: false, isWritable: false },
      { pubkey: SPL_TOKEN_PROGRAM,              isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM,                 isSigner: false, isWritable: false },
    ],
    data: burnData,
  });

  const burnTx = new Transaction();
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  burnTx.recentBlockhash = blockhash;
  burnTx.feePayer = params.solanaKeypair.publicKey;
  burnTx.add(burnIx);
  burnTx.sign(params.solanaKeypair, messageSentEventData);

  const burnSig = await connection.sendRawTransaction(burnTx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction({ signature: burnSig, blockhash, lastValidBlockHeight }, "confirmed");
  console.log(`[cctp-v2] Solana depositForBurn confirmed: ${burnSig}`);

  // ── 2. Poll V2 attestation (Solana source domain = 5) ───────────────────────
  console.log(`[cctp-v2] polling V2 iris API (Solana domain=${DOMAIN_SOLANA})...`);
  const { message, attestation } = await pollAttestationV2(DOMAIN_SOLANA, burnSig);
  console.log(`[cctp-v2] V2 attestation received`);

  // ── 3. receiveMessage on Base V2 (MessageTransmitterV2) ─────────────────────
  const testnet   = isTestnet();
  const chain     = testnet ? baseSepolia : base;
  const rpc       = testnet ? getBaseSepoliaRpc() : getBaseRpc();
  const baseMessageTransmitter = testnet ? SEPOLIA_MESSAGE_TRANSMITTER : BASE_MESSAGE_TRANSMITTER;

  const account      = privateKeyToAccount(params.relayerPrivateKey as `0x${string}`);
  const walletClient = createWalletClient({ account, chain, transport: http(rpc) });
  const publicClient = createPublicClient({ chain, transport: http(rpc) });

  console.log(`[cctp-v2] receiveMessage on Base V2: ${baseMessageTransmitter}`);
  const msgHex = (message.startsWith("0x") ? message : `0x${message}`) as `0x${string}`;
  const attHex = (attestation.startsWith("0x") ? attestation : `0x${attestation}`) as `0x${string}`;

  const receiveTxHash = await walletClient.writeContract({
    address: baseMessageTransmitter,
    abi: MESSAGE_TRANSMITTER_ABI,
    functionName: "receiveMessage",
    args: [msgHex, attHex],
    gas: 300_000n,
  });
  await publicClient.waitForTransactionReceipt({ hash: receiveTxHash });
  console.log(`[cctp-v2] receiveMessage on Base confirmed: ${receiveTxHash}`);

  return { sourceTxHash: burnSig, destTxHash: receiveTxHash, bridgeTimeMs: Date.now() - start };
}
