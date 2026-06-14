import {
  Connection,
  Keypair,
  VersionedTransaction,
  PublicKey,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAccount,
} from "@solana/spl-token";

// ── Jupiter v6 Swap API ────────────────────────────────────────────────────────
//
// Ondo GM tokens (SPCXon, TSLAon, etc.) are minted JIT via Jupiter RFQ:
//   User signs a Jupiter fill tx → Ondo solver submits Jito bundle [mint_gm + fill]
//   No LP wallet needed on Gitbank's side — Ondo's authorized solvers handle minting.
//
// Authorized Ondo solvers (from ondoprotocol/gm-solana-simulator):
//   AMJ81TnD4EWftmVPxppiEPsSFbmfYAvvLkUaNDXuR7JH
//   DSqMPMsMAbEJVNuPKv1ZFdzt6YvJaDPDddfeW7ajtqds
//   2Cq2RNFFxxPXL7teNQAxi1beA2vFbBDYW5BGPBFvoN9m
//   9BB7Tt5uE5VdRsxA5XRqrjwNaq8XtgAUQW8czA6ymUPG
//
// Jupiter RFQ notes:
//   - SPCXon launched June 12, 2026. Jupiter indexes new tokens within days.
//   - If quote returns "no route found", token not yet indexed by Jupiter.
//   - Mock mode (ONDO_MOCK=true) bypasses all network calls for local E2E.
//
// References:
//   https://github.com/ondoprotocol/global-markets-solana  — Ondo GM program
//   https://github.com/ondoprotocol/gm-solana-simulator    — JIT mint simulation
//   Jupiter v6 docs: https://station.jup.ag/docs/apis/swap-api

const JUPITER_QUOTE_API = "https://quote-api.jup.ag/v6";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// 1% slippage tolerance for GM tokens (wide enough for JIT price discovery)
const SLIPPAGE_BPS = 100;

// ── Env helpers ────────────────────────────────────────────────────────────────

function getSolanaRpc(): string {
  return process.env["SOLANA_RPC_URL"] ?? "https://api.mainnet-beta.solana.com";
}

function isMockMode(): boolean {
  return process.env["ONDO_MOCK"] === "true";
}

// ── Market hours ────────────────────────────────────────────────────────────────
//
// Ondo GM tokens are available 24/5: Sunday 8:00 PM ET → Friday 8:00 PM ET.
// Outside this window Jupiter will return no routes — surface a clear error.
// Reference: https://status.ondo.finance/market

/**
 * Thrown when the Ondo GM market is closed (outside 24/5 window).
 * Catch this in webhook handlers to post a friendly GitHub comment.
 */
export class MarketClosedError extends Error {
  public readonly nextOpenStr: string;
  constructor(nextOpenStr: string) {
    super(`Ondo GM market is currently closed. ${nextOpenStr}`);
    this.name = "MarketClosedError";
    this.nextOpenStr = nextOpenStr;
  }
}

/** Returns the ET UTC offset in hours (-4 EDT, -5 EST) for a given Date. */
function etOffsetHours(d: Date): number {
  const year = d.getUTCFullYear();
  // DST: second Sunday in March at 2am ET (7am UTC during EST)
  const marchDay1 = new Date(Date.UTC(year, 2, 1)).getUTCDay(); // day-of-week for Mar 1
  const dstStart = new Date(Date.UTC(year, 2, 8 + ((7 - marchDay1) % 7), 7, 0, 0));
  // DST end: first Sunday in November at 2am ET (6am UTC during EDT)
  const novDay1 = new Date(Date.UTC(year, 10, 1)).getUTCDay();
  const dstEnd = new Date(Date.UTC(year, 10, 1 + ((7 - novDay1) % 7), 6, 0, 0));
  return d >= dstStart && d < dstEnd ? -4 : -5;
}

/** Returns the current ET time as a Date (UTC shifted by ET offset). */
function nowET(): Date {
  const now = new Date();
  return new Date(now.getTime() + etOffsetHours(now) * 3_600_000);
}

/**
 * Returns true when the Ondo GM market is open.
 * Market window: Sunday 20:00 ET (open) → Friday 20:00 ET (close).
 */
export function isMarketOpen(): boolean {
  const et = nowET();
  const day = et.getUTCDay();       // 0=Sun, 5=Fri, 6=Sat
  const hour = et.getUTCHours();
  const min = et.getUTCMinutes();
  const timeMin = hour * 60 + min;
  const closeMin = 20 * 60;         // 8:00 PM ET

  if (day === 6) return false;                             // Saturday = always closed
  if (day === 5 && timeMin >= closeMin) return false;      // Friday after 8pm
  if (day === 0 && timeMin < closeMin) return false;       // Sunday before 8pm
  return true;
}

/** Returns a human-readable string for when the market next opens. */
export function nextMarketOpenStr(): string {
  const et = nowET();
  const day = et.getUTCDay();
  const timeMin = et.getUTCHours() * 60 + et.getUTCMinutes();
  const closeMin = 20 * 60;

  // How many minutes until Sunday 8pm ET?
  let minsUntilSunday8pm: number;
  if (day === 6) {
    // Saturday: 1 day + (20*60 - timeMin) minutes
    minsUntilSunday8pm = 24 * 60 + (closeMin - timeMin);
  } else if (day === 5) {
    // Friday after 8pm: 2 days + (20*60 - timeMin) minutes
    minsUntilSunday8pm = 2 * 24 * 60 + (closeMin - timeMin);
  } else {
    // Sunday before 8pm
    minsUntilSunday8pm = closeMin - timeMin;
  }

  const h = Math.floor(minsUntilSunday8pm / 60);
  const m = minsUntilSunday8pm % 60;
  const timeLabel = h > 0 ? `${h}h ${m}m` : `${m}m`;
  return `Market reopens Sunday at 8:00 PM ET (in ~${timeLabel}). Ondo GM tokens trade 24/5: Sunday 8 PM ET - Friday 8 PM ET.`;
}

// ── Types ──────────────────────────────────────────────────────────────────────

export interface QuoteResult {
  outAmount: bigint;
  priceImpactPct: number;
  routePlan: string;
  quoteResponse: unknown;
}

export interface SwapResult {
  txHash: string;
  amountReceived: bigint;
}

interface JupiterQuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  priceImpactPct: string;
  routePlan: Array<{ swapInfo: { label: string } }>;
  error?: string;
}

interface JupiterSwapResponse {
  swapTransaction: string;
  error?: string;
}

// ── Jupiter API helpers ────────────────────────────────────────────────────────

async function fetchJupiterQuote(
  inputMint: string,
  outputMint: string,
  amount: bigint,
): Promise<JupiterQuoteResponse> {
  const url = new URL(`${JUPITER_QUOTE_API}/quote`);
  url.searchParams.set("inputMint", inputMint);
  url.searchParams.set("outputMint", outputMint);
  url.searchParams.set("amount", amount.toString());
  url.searchParams.set("slippageBps", SLIPPAGE_BPS.toString());
  // Enable RFQ market makers (Ondo solvers) alongside regular AMM routes
  url.searchParams.set("onlyDirectRoutes", "false");

  const res = await fetch(url.toString());
  const data = await res.json() as JupiterQuoteResponse;

  if (!res.ok || data.error) {
    throw new Error(
      `Jupiter quote failed (${res.status}): ${data.error ?? "unknown error"}. ` +
      `Token ${outputMint} may not yet be indexed by Jupiter — try again in 24-48h.`,
    );
  }
  return data;
}

async function fetchJupiterSwapTx(
  quoteResponse: JupiterQuoteResponse,
  userPublicKey: string,
): Promise<Buffer> {
  const res = await fetch(`${JUPITER_QUOTE_API}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: false,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    }),
  });

  const data = await res.json() as JupiterSwapResponse;
  if (!res.ok || data.error) {
    throw new Error(
      `Jupiter swap TX failed (${res.status}): ${data.error ?? "unknown error"}`,
    );
  }
  return Buffer.from(data.swapTransaction, "base64");
}

// ── Quote functions ────────────────────────────────────────────────────────────

/**
 * Get a Jupiter quote for USDC → Ondo GM stock.
 * Throws if no route found (token not yet indexed by Jupiter).
 */
export async function quoteUsdcToStock(
  stockMintAddress: string,
  usdcAmount: bigint,
): Promise<QuoteResult> {
  if (isMockMode()) {
    return {
      outAmount: 100_000_000n,
      priceImpactPct: 0,
      routePlan: "mock:ondo:jit",
      quoteResponse: { mock: true },
    };
  }

  const quote = await fetchJupiterQuote(USDC_MINT, stockMintAddress, usdcAmount);
  return {
    outAmount: BigInt(quote.outAmount),
    priceImpactPct: parseFloat(quote.priceImpactPct),
    routePlan: quote.routePlan.map(r => r.swapInfo.label).join(" → "),
    quoteResponse: quote,
  };
}

/**
 * Get a Jupiter quote for Ondo GM stock → USDC.
 * Throws if no route found (token not yet indexed by Jupiter).
 */
export async function quoteStockToUsdc(
  stockMintAddress: string,
  stockAmount: bigint,
): Promise<QuoteResult> {
  if (isMockMode()) {
    return {
      outAmount: 5_000_000n,
      priceImpactPct: 0,
      routePlan: "mock:ondo:jit",
      quoteResponse: { mock: true },
    };
  }

  const quote = await fetchJupiterQuote(stockMintAddress, USDC_MINT, stockAmount);
  return {
    outAmount: BigInt(quote.outAmount),
    priceImpactPct: parseFloat(quote.priceImpactPct),
    routePlan: quote.routePlan.map(r => r.swapInfo.label).join(" → "),
    quoteResponse: quote,
  };
}

// ── buyStock ───────────────────────────────────────────────────────────────────

/**
 * Buy an Ondo GM stock token using USDC via Jupiter RFQ.
 *
 * Jupiter routes through Ondo's authorized solvers. The solver handles
 * the JIT mint_gm + fill as a Jito bundle — Gitbank has no LP role here.
 *
 * Requirements:
 *   - userKeypair.publicKey must have USDC on Solana (bridged via CCTP)
 *   - userKeypair.publicKey must have SOL for tx fees (funded by relayer at wallet creation)
 *   - Jupiter must have indexed the stock mint (may take 24-48h for new tokens)
 *
 * @param stockMintAddress  Token-2022 mint of the Ondo stock (e.g. SPCXon)
 * @param usdcAmount        USDC to spend (6 decimals, e.g. 5_000_000 = 5 USDC)
 * @param userKeypair       User's Solana custody wallet (signs the Jupiter tx)
 */
export async function buyStock(
  stockMintAddress: string,
  usdcAmount: bigint,
  userKeypair: Keypair,
): Promise<SwapResult> {
  if (isMockMode()) {
    console.log(`[jupiter] MOCK buy: ${usdcAmount} USDC → ${stockMintAddress}`);
    return {
      txHash: `MOCK_JUP_BUY_${Date.now()}`,
      amountReceived: 100_000_000n,
    };
  }

  // Ondo GM tokens only trade 24/5 — check before making any network calls
  if (!isMarketOpen()) {
    throw new MarketClosedError(nextMarketOpenStr());
  }

  const connection = new Connection(getSolanaRpc(), "confirmed");
  const userPubkey = userKeypair.publicKey.toBase58();

  console.log(`[jupiter] buy: ${usdcAmount} USDC → ${stockMintAddress} (user: ${userPubkey.slice(0, 8)}...)`);

  // 1. Get quote
  const quote = await fetchJupiterQuote(USDC_MINT, stockMintAddress, usdcAmount);
  const expectedOut = BigInt(quote.outAmount);
  console.log(`[jupiter] quote: ${usdcAmount} USDC → ${expectedOut} stock (impact: ${quote.priceImpactPct}%)`);

  // 2. Get swap transaction from Jupiter
  const txBuf = await fetchJupiterSwapTx(quote, userPubkey);
  const tx = VersionedTransaction.deserialize(txBuf);

  // 3. Sign with user's keypair
  tx.sign([userKeypair]);

  // 4. Send + confirm
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const txHash = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  console.log(`[jupiter] buy tx sent: ${txHash}`);

  await connection.confirmTransaction(
    { signature: txHash, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  console.log(`[jupiter] buy confirmed`);

  // 5. Read actual received amount from user's stock ATA
  const stockMint = new PublicKey(stockMintAddress);
  const stockAta = getAssociatedTokenAddressSync(
    stockMint,
    userKeypair.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  let amountReceived = expectedOut;
  try {
    const stockAcct = await getAccount(connection, stockAta, "confirmed", TOKEN_2022_PROGRAM_ID);
    amountReceived = stockAcct.amount;
  } catch {
    console.warn(`[jupiter] could not read stock ATA balance, using quote amount`);
  }

  return { txHash, amountReceived };
}

// ── sellStock ──────────────────────────────────────────────────────────────────

/**
 * Sell an Ondo GM stock token for USDC via Jupiter RFQ.
 *
 * Jupiter routes through Ondo's authorized solvers. The solver handles
 * the redeem + fill — Gitbank has no LP role here.
 *
 * Requirements:
 *   - userKeypair.publicKey must have the stock token (SPCXon) on Solana
 *   - userKeypair.publicKey must have SOL for tx fees
 *   - minUsdcOut: minimum USDC to accept (slippage guard), must be > 0
 *     Compute: (sellAmount * totalCostUsdc * 95n) / (totalStock * 100n)
 *
 * @param stockMintAddress  Token-2022 mint of the Ondo stock
 * @param stockAmount       Stock tokens to sell (9 decimals)
 * @param userKeypair       User's Solana custody wallet
 * @param minUsdcOut        Minimum USDC to accept (6 decimals), must be > 0
 */
export async function sellStock(
  stockMintAddress: string,
  stockAmount: bigint,
  userKeypair: Keypair,
  minUsdcOut: bigint,
): Promise<SwapResult> {
  if (isMockMode()) {
    console.log(`[jupiter] MOCK sell: ${stockAmount} stock → USDC (min: ${minUsdcOut})`);
    return {
      txHash: `MOCK_JUP_SELL_${Date.now()}`,
      amountReceived: minUsdcOut > 0n ? minUsdcOut : 5_000_000n,
    };
  }

  // Ondo GM tokens only trade 24/5 — check before making any network calls
  if (!isMarketOpen()) {
    throw new MarketClosedError(nextMarketOpenStr());
  }

  if (minUsdcOut <= 0n) {
    throw new Error(
      "sellStock: minUsdcOut must be > 0. " +
      "Compute: (sellAmount * totalCostUsdc * 95n) / (totalStock * 100n)",
    );
  }

  const connection = new Connection(getSolanaRpc(), "confirmed");
  const userPubkey = userKeypair.publicKey.toBase58();

  console.log(`[jupiter] sell: ${stockAmount} stock → USDC (min: ${minUsdcOut}, user: ${userPubkey.slice(0, 8)}...)`);

  // 1. Get quote: stock → USDC
  const quote = await fetchJupiterQuote(stockMintAddress, USDC_MINT, stockAmount);
  const expectedUsdc = BigInt(quote.outAmount);

  // Enforce minUsdcOut as additional guard (Jupiter slippage + our cost-basis check)
  if (expectedUsdc < minUsdcOut) {
    throw new Error(
      `sellStock: Jupiter quote (${expectedUsdc} USDC) is below minUsdcOut (${minUsdcOut}). ` +
      `Price may have moved. Retry or accept lower floor.`,
    );
  }
  console.log(`[jupiter] sell quote: ${stockAmount} stock → ${expectedUsdc} USDC (impact: ${quote.priceImpactPct}%)`);

  // 2. Get swap transaction
  const txBuf = await fetchJupiterSwapTx(quote, userPubkey);
  const tx = VersionedTransaction.deserialize(txBuf);

  // 3. Sign
  tx.sign([userKeypair]);

  // 4. Send + confirm
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const txHash = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  console.log(`[jupiter] sell tx sent: ${txHash}`);

  await connection.confirmTransaction(
    { signature: txHash, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  console.log(`[jupiter] sell confirmed`);

  // 5. Return USDC received (use quote output as confirmed amount)
  return { txHash, amountReceived: expectedUsdc };
}
