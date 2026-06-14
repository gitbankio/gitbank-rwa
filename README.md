# gitbank-rwa

Soul-bound tokenized stock layer for Gitbank. Base L2 contracts and
cross-chain integration libraries for Ondo Finance RWA assets.

## What is this?

gitStock lets GitHub contributors hold tokenized stocks inside their
Gitbank vault on Base L2. Each position is:

- Soul-bound: non-transferable, cannot be phished or drained via approvals
- Backed 1:1: each gitStock token represents one Ondo tokenized stock on Solana
- Bot-operated: users buy/sell via GitHub bot mentions, no wallet required

## Architecture

    User: @gitbankbot buy 100 USDC of SPCX
              |
              v
    Gitbank server (Base L2)
       |-- CCTP V2: bridge USDC Base -> Solana
       |-- Jupiter v6 RFQ: USDC -> Ondo SPCXon (JIT mint by Ondo solvers)
       |-- Relayer: mint GitStockToken (ERC-20) on Base to user vault
              |
              v
    User's GitVault: soul-bound SPCX gitStock tokens

## Contracts (Base Mainnet)

| Contract        | Address                                      |
|-----------------|----------------------------------------------|
| GitStockFactory | `0x916542efC65b82Ab1a8d64DFB695621c9b810416` |
| Deployer/owner  | `0x1e660A9A1f1F08AFEF9c03c96D66260122464CF2` |
| relayerSigner   | `0x750E6E4C5DF3483a6235D3DDAB4087266D6EF510` |

Basescan: https://basescan.org/address/0x916542efC65b82Ab1a8d64DFB695621c9b810416

### GitStockToken

Soul-bound ERC-20, **9 decimals** (matches Ondo Token-2022 SPL tokens on Solana).
Mint/burn by relayerSigner only. Transfer, approve, and transferFrom permanently disabled.

### GitStockFactory

Deploys one GitStockToken per ticker (onlyDeployer). Tracks all deployed tickers.

## Packages

| Package                 | Description                                          |
|-------------------------|------------------------------------------------------|
| @gitbank/rwa            | 548 Ondo asset registry entries + Pyth price feeds   |
| @gitbank/solana-relayer | AES-256-GCM encrypted Solana keypairs + SOL funding  |
| @gitbank/jupiter        | Jupiter v6 RFQ: market hours check + swap execution  |
| @gitbank/cctp           | CCTP V2 bridge helpers (Base <-> Solana), full impl  |

## Market Hours

Ondo GM tokens trade **24/5**: Sunday 8:00 PM ET through Friday 8:00 PM ET.

The `@gitbank/jupiter` package enforces this automatically. When the market
is closed, `buyStock()` and `sellStock()` throw `MarketClosedError` with a
human-readable message showing when the market reopens (DST-aware ET time).

The bot posts a clear GitHub comment when a command is rejected due to market hours:

> Ondo GM market is currently closed.
> Market reopens Sunday at 8:00 PM ET (in ~Xh Ym).
> Ondo GM tokens trade 24/5: Sunday 8 PM ET - Friday 8 PM ET.

## Supported Assets

548 Ondo tokenized equities and ETFs. Mint addresses fetched on-chain from the
Ondo GM program (`XzTT4XB8m7sLD2xi6snefSasaswsKCxx5Tifjondogm`) via Helius RPC.

Sample tickers: NVDA, AAPL, TSLA, META, MSFT, GOOGL, AMZN, SPCX, SPY, QQQ, CRCL, ...

All tokens are Token-2022 with tokenMetadata extension, decimals=9.

Prices via Pyth oracle. Assets without a Pyth ID fall back to dev mock prices.

## Development

```bash
pnpm install
pnpm --filter @workspace/contracts run compile
pnpm --filter @workspace/contracts run test
```

Mock mode (no real cross-chain calls):

```bash
CCTP_MOCK=true ONDO_MOCK=true node your-script.js
```

## Status

- Contracts: compiled, 13/13 tests passing, Apache-2.0 verified on Basescan
- GitStockFactory: deployed Base Mainnet (`0x916542efC65b82Ab1a8d64DFB695621c9b810416`)
- CCTP: fully implemented (Base->Solana and Solana->Base, CCTP V2)
- Jupiter: fully implemented (RFQ swap via Ondo JIT mint, market hours check)
- Registry: 548 real Ondo mint addresses (Token-2022, decimals=9)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
