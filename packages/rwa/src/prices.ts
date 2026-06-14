import { getAsset, listTickers } from "./registry.js";

const PYTH_HERMES_URL = process.env["PYTH_HERMES_URL"] ?? "https://hermes.pyth.network";

interface PythPriceResponse {
  parsed: Array<{
    id: string;
    price: {
      price: string;
      expo: number;
    };
  }>;
}

/**
 * Get live USD price for a single stock ticker from Pyth oracle.
 * Returns price as a JavaScript number (USD).
 */
export async function getLivePrice(ticker: string): Promise<number> {
  const asset = getAsset(ticker);
  if (asset.pythPriceId.startsWith("TBD")) {
    // Return a mock price during development
    return getMockPrice(ticker);
  }

  try {
    const url = `${PYTH_HERMES_URL}/v2/updates/price/latest?ids[]=${asset.pythPriceId}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Pyth API error ${res.status} for ${ticker}`);

    const data = (await res.json()) as PythPriceResponse;
    const parsed = data.parsed?.[0];
    if (!parsed) throw new Error(`No Pyth price data for ${ticker}`);

    const raw = Number(parsed.price.price);
    const expo = parsed.price.expo;
    return raw * Math.pow(10, expo);
  } catch {
    // Fall back to mock prices when Pyth is unavailable (dev / testnet)
    return getMockPrice(ticker);
  }
}

/**
 * Get live USD prices for multiple tickers in one Pyth API call.
 */
export async function getAllPrices(tickers: string[]): Promise<Record<string, number>> {
  const results: Record<string, number> = {};

  // Separate TBD vs real
  const real = tickers.filter((t) => !getAsset(t).pythPriceId.startsWith("TBD"));
  const mocked = tickers.filter((t) => getAsset(t).pythPriceId.startsWith("TBD"));

  for (const t of mocked) results[t] = getMockPrice(t);

  if (real.length === 0) return results;

  try {
    const ids = real.map((t) => getAsset(t).pythPriceId).map((id) => `ids[]=${id}`).join("&");
    const url = `${PYTH_HERMES_URL}/v2/updates/price/latest?${ids}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Pyth API error ${res.status}`);

    const data = (await res.json()) as PythPriceResponse;
    for (const p of data.parsed ?? []) {
      const ticker = real.find((t) => getAsset(t).pythPriceId === `0x${p.id}`);
      if (!ticker) continue;
      results[ticker] = Number(p.price.price) * Math.pow(10, p.price.expo);
    }
  } catch {
    // Fall back to mock prices for any tickers that weren't filled
    for (const t of real) {
      if (!(t in results)) results[t] = getMockPrice(t);
    }
  }

  return results;
}

/**
 * Get prices for all known tickers.
 */
export async function getAllKnownPrices(): Promise<Record<string, number>> {
  return getAllPrices(listTickers());
}

/** Mock prices for development/testing (realistic values) */
function getMockPrice(ticker: string): number {
  const mocks: Record<string, number> = {
    NVDA: 274.25,
    AAPL: 213.40,
    TSLA: 178.60,
    META: 512.30,
    MSFT: 445.20,
    GOOGL: 185.40,
    AMZN: 198.70,
    CRCL: 34.50,
    SPCX: 185.00,
    SPY: 598.12,
    QQQ: 502.45,
  };
  return mocks[ticker.toUpperCase()] ?? 100.0;
}
