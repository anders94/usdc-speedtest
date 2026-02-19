# usdc-speedtest

Benchmark EVM network throughput by sending USDC transfers in parallel.

Derives deterministic wallet pairs from a master key, funds them, runs back-and-forth USDC transfers across N parallel testers, and reports throughput and latency statistics.

## Quick Start

```bash
npm install
npm run build

# Set your master wallet private key
export PRIVATE_KEY=0x...

# Run with defaults (Base Sepolia, 5 testers, 60s)
npx usdc-speedtest

# Or link globally so `usdc-speedtest` works anywhere
npm link
usdc-speedtest

# Or run directly without installing
node dist/cli.js
```

## How It Works

1. **Derive wallets** — deterministically generates 2N wallets (N pairs) from the master key using BIP-44 HD derivation (`m/44'/60'/0'/0`)
2. **Fund wallets** — sends ETH (for gas) and USDC ($0.01 per sender) from the master wallet to each derived wallet
3. **Run test** — each tester ping-pongs $0.01 USDC between its wallet pair for the configured duration
4. **Report stats** — aggregates throughput (tx/s), latency percentiles (p50/p95/p99), and gas usage
5. **Cleanup** — optionally sweeps all funds back to the master wallet

## CLI Options

```
usdc-speedtest [options]

Options:
  -n, --network <name>      Network name (default: "baseSepolia")
  -p, --parallel <count>    Number of parallel testers (default: "5")
  -d, --duration <seconds>  Test duration in seconds (default: "60")
  --rpc <url>               Override RPC endpoint
  --usdc-address <addr>     Override USDC contract address
  --chain-id <id>           Override chain ID
  --cleanup                 Sweep funds from derived wallets back to master
  --skip-funding            Skip the wallet funding step
  -h, --help                Display help
```

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `PRIVATE_KEY` | Yes | Master wallet private key (hex, with or without `0x` prefix) |

Create a `.env` file in the project root or set it in your shell. The master wallet needs enough ETH for gas and enough USDC to fund sender wallets.

## Supported Networks

| Network | Flag | Chain ID | Block Time |
|---------|------|----------|------------|
| Ethereum Mainnet | `mainnet` | 1 | ~12s |
| Ethereum Sepolia | `sepolia` | 11155111 | ~12s |
| Base | `base` | 8453 | ~2s |
| **Base Sepolia** | `baseSepolia` | 84532 | ~2s |
| Radius | `radius` | — | ~0.5s |
| Radius Testnet | `radiusTestnet` | — | ~0.5s |

For networks without built-in configs (or custom chains), use `--rpc`, `--usdc-address`, and `--chain-id` overrides.

## Batch Funding via Disperse.app

When the [Disperse.app](https://disperse.app) contract is detected on the target chain, funding is batched into 3 transactions regardless of wallet count:

| Step | Transaction | Description |
|------|-------------|-------------|
| 1 | `disperseEther()` | Batch ETH to all wallets in one tx |
| 2 | `approve()` | Approve Disperse to spend USDC |
| 3 | `disperseToken()` | Batch USDC to all sender wallets in one tx |

If Disperse is unavailable (e.g. a new chain), the tool falls back to individual transactions with nonce pipelining.

## Examples

```bash
# Base Sepolia, 10 parallel testers, 2 minutes
usdc-speedtest -n baseSepolia -p 10 -d 120

# Ethereum mainnet, 3 testers, 30 seconds
usdc-speedtest -n mainnet -p 3 -d 30

# Custom RPC and USDC address
usdc-speedtest --rpc https://my-rpc.example.com --usdc-address 0x... --chain-id 12345

# Sweep all funds back to master wallet
usdc-speedtest --cleanup
```

## Development

```bash
npm install
npm run dev          # Run directly via tsx
npm run build        # Build to dist/
```

## Project Structure

```
src/
  cli.ts                  Entry point and argument parsing
  config/networks.ts      Network definitions
  wallet/derive.ts        HD wallet derivation and pairing
  wallet/fund.ts          Balance checks, funding plan, Disperse batching
  test/runner.ts          Parallel test orchestration, Ctrl+C handling
  test/tester.ts          Single tester: ping-pong USDC between wallet pair
  test/stats.ts           Statistics computation and display
  cleanup/sweep.ts        Sweep USDC and ETH back to master
  utils/usdc.ts           ERC-20 ABI and USDC helpers
  utils/disperse.ts       Disperse.app contract detection and helpers
  utils/prompt.ts         Interactive confirmation prompts
  utils/logger.ts         Formatted console output
```

## License

MIT
