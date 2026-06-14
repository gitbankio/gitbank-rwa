import { PublicKey, Connection } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddress } from "@solana/spl-token";
import { getSolanaConnection } from "./wallet.js";

/**
 * Get SPL token balance for a wallet + mint address.
 * Returns 0n if token account does not exist.
 */
export async function getTokenBalance(
  walletPublicKey: string,
  mintAddress: string,
): Promise<bigint> {
  const connection = getSolanaConnection();
  const wallet = new PublicKey(walletPublicKey);
  const mint = new PublicKey(mintAddress);

  try {
    const ata = await getAssociatedTokenAddress(mint, wallet);
    const account = await getAccount(connection, ata);
    return account.amount;
  } catch {
    // Token account does not exist → balance is 0
    return 0n;
  }
}

/**
 * Get balances for multiple SPL tokens at once.
 */
export async function getMultipleTokenBalances(
  walletPublicKey: string,
  mintAddresses: string[],
): Promise<Record<string, bigint>> {
  const results: Record<string, bigint> = {};
  await Promise.all(
    mintAddresses.map(async (mint) => {
      results[mint] = await getTokenBalance(walletPublicKey, mint);
    }),
  );
  return results;
}
