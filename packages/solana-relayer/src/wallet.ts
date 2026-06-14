import { Keypair, Connection, Transaction, SystemProgram, PublicKey } from "@solana/web3.js";
import { db } from "@workspace/db";
import { solanaWallets } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { encryptSolanaKey, decryptSolanaKey } from "./crypto.js";
import bs58 from "bs58";

function getSolanaRpc(): string {
  return process.env["SOLANA_RPC_URL"] ?? "https://api.mainnet-beta.solana.com";
}

export function getSolanaConnection(): Connection {
  return new Connection(getSolanaRpc(), "confirmed");
}

/**
 * Generate a new Solana keypair, encrypt and store it in DB.
 * Idempotent — if wallet already exists for githubId, returns existing.
 */
export async function getOrCreateSolanaWallet(githubId: string): Promise<{
  publicKey: string;
  keypair: Keypair;
}> {
  // Check existing
  const existing = await db
    .select()
    .from(solanaWallets)
    .where(eq(solanaWallets.githubId, githubId))
    .limit(1);

  if (existing[0]) {
    const decrypted = decryptSolanaKey(existing[0].encryptedPrivKey);
    const secretKey = bs58.decode(decrypted);
    const keypair = Keypair.fromSecretKey(secretKey);
    return { publicKey: existing[0].publicKey, keypair };
  }

  // Generate new
  const keypair = Keypair.generate();
  const privateKeyBase58 = bs58.encode(keypair.secretKey);
  const publicKey = keypair.publicKey.toBase58();
  const encryptedPrivKey = encryptSolanaKey(privateKeyBase58);

  await db.insert(solanaWallets).values({
    githubId,
    encryptedPrivKey,
    publicKey,
  });

  // Fund new wallet so it can pay CCTP + Jupiter transaction fees
  await fundSolanaWallet(publicKey);

  return { publicKey, keypair };
}

/**
 * Send ~0.005 SOL to a new wallet from the Solana relayer keypair.
 * Requires SOLANA_RELAYER_KEY env var (base58-encoded Solana private key).
 * If the key is not set, logs a warning and skips funding.
 */
async function fundSolanaWallet(pubkey: string): Promise<void> {
  const solanaRelayerKey = process.env["SOLANA_RELAYER_KEY"];
  if (!solanaRelayerKey) {
    console.warn("[solana-relayer] SOLANA_RELAYER_KEY not set — new wallet will have 0 SOL, fund manually before CCTP/Jupiter ops");
    return;
  }
  try {
    const connection = getSolanaConnection();
    const relayerKeypair = Keypair.fromSecretKey(bs58.decode(solanaRelayerKey));
    const { blockhash } = await connection.getLatestBlockhash();

    const tx = new Transaction();
    tx.recentBlockhash = blockhash;
    tx.feePayer = relayerKeypair.publicKey;
    tx.add(
      SystemProgram.transfer({
        fromPubkey: relayerKeypair.publicKey,
        toPubkey: new PublicKey(pubkey),
        lamports: 5_000_000, // 0.005 SOL — enough for ~20-30 CCTP + Jupiter txs
      }),
    );
    tx.sign(relayerKeypair);

    const sig = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction(sig, "confirmed");
    console.info("[solana-relayer] Funded new wallet", pubkey, "with 0.005 SOL, sig:", sig);
  } catch (err) {
    // Non-fatal — log and continue; user will need to top up manually
    console.warn("[solana-relayer] SOL funding failed for", pubkey, "—", (err as Error).message);
  }
}

/**
 * Get decrypted Keypair for an existing wallet.
 * Throws if wallet does not exist.
 */
export async function getSolanaKeypair(githubId: string): Promise<Keypair> {
  const row = await db
    .select()
    .from(solanaWallets)
    .where(eq(solanaWallets.githubId, githubId))
    .limit(1);

  if (!row[0]) throw new Error(`No Solana wallet found for githubId: ${githubId}`);

  const decrypted = decryptSolanaKey(row[0].encryptedPrivKey);
  const secretKey = bs58.decode(decrypted);
  return Keypair.fromSecretKey(secretKey);
}

/**
 * Get public key for a github user (no decryption needed).
 */
export async function getSolanaPublicKey(githubId: string): Promise<string | null> {
  const row = await db
    .select({ publicKey: solanaWallets.publicKey })
    .from(solanaWallets)
    .where(eq(solanaWallets.githubId, githubId))
    .limit(1);

  return row[0]?.publicKey ?? null;
}
