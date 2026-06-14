# Contributing to gitbankio/gitbank-rwa

Thanks for your interest in contributing.

## Before you start

- Open an issue first for non-trivial changes
- For bugs, include steps to reproduce and expected vs actual behavior
- For security issues, do not open a public issue

## Development setup

```bash
pnpm install
pnpm --filter @workspace/contracts run compile
pnpm --filter @workspace/contracts run test
```

Mock mode (no real cross-chain calls):

```bash
CCTP_MOCK=true JUPITER_MOCK=true node your-script.js
```

## Conventions

- Solidity 0.8.24, optimizer enabled
- All public functions must have NatSpec comments
- TypeScript strict mode, no `any`
- Pyth price IDs must be verified from https://pyth.network/developers/price-feed-ids
- Ondo mint addresses must be verified from Ondo docs before any mainnet use

## Testing

All tests must pass before opening a PR:

```bash
pnpm --filter @workspace/contracts run test
```

Add tests for any new ticker, contract function, or bridge path.

## Pull requests

- One concern per PR
- Clear description of what changed and why
- Reference related issues with `Closes #<number>`

## License

By contributing, you agree that your contributions will be licensed under the Apache License 2.0.
