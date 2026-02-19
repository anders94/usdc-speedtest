# USDC Speedtest — Implementation Plan

## Overview

A TypeScript CLI tool (`npx usdc-speedtest`) that benchmarks EVM network throughput by sending USDC transfers in parallel. It deterministically derives wallet pairs from a master private key, funds them, runs back-and-forth USDC transfers, and reports throughput statistics.

---

## Architecture

```
src/
  cli.ts              # Entry point — argument parsing, interactive flow
  config/
    networks.ts       # Network definitions (chainId, RPC, USDC address, gas minimums)
  wallet/
    derive.ts         # HD wallet derivation from master key
    fund.ts           # Check balances & build funding transactions
  test/
    runner.ts         # Spawn parallel testers, coordinate start/stop
    tester.ts         # Single tester: ping-pong USDC between wallet pair
    stats.ts          # Collect and summarize statistics
  cleanup/
    sweep.ts          # Return funds from derived wallets → master
  utils/
    prompt.ts         # Interactive confirmation helpers
    usdc.ts           # USDC contract ABI + helpers (transfer, balanceOf)
    logger.ts         # Formatted console output
```

---

## Step-by-Step Implementation Plan

### Step 1: Project Scaffolding

- Initialize `package.json` with `name: "usdc-speedtest"`, `bin` field pointing to `dist/cli.js`
- Install dependencies:
  - `ethers` (v6) — wallet derivation, contract interaction, tx signing
  - `commander` — CLI argument parsing
  - `dotenv` — load `.env` for `PRIVATE_KEY`
  - `chalk` — colored terminal output
  - `ora` — spinners for long operations
- Dev dependencies: `typescript`, `tsup`, `@types/node`
- Configure `tsconfig.json` (target ES2022, module NodeNext)
- Configure `tsup.config.ts` (entry: `src/cli.ts`, format: ESM, banner with shebang)

### Step 2: Network Configuration (`src/config/networks.ts`)

Define a `NetworkConfig` type and a registry of supported networks:

```typescript
type NetworkConfig = {
  name: string;
  chainId: number;
  rpcUrl: string;               // default, overridable via --rpc flag
  usdcAddress: string;
  minEthPerWallet: bigint;      // wei — enough for ~100 ERC-20 transfers
  blockExplorerUrl?: string;
};
```

| Network | chainId | USDC Address | minEth (approx) |
|---|---|---|---|
| `mainnet` | 1 | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | 0.005 ETH |
| `sepolia` | 11155111 | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` | 0.05 ETH |
| `base` | 8453 | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | 0.0001 ETH |
| `baseSepolia` | 84532 | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | 0.005 ETH |
| `radius` | TBD | TBD (placeholder) | TBD |
| `radiusTestnet` | TBD | TBD (placeholder) | TBD |

Radius entries will have placeholder values and a warning that they are not yet fully supported. The user can supply `--rpc`, `--usdc-address`, and `--chain-id` flags to override defaults, making it usable once Radius launches USDC.

### Step 3: CLI Entry Point (`src/cli.ts`)

Using `commander`:

```
usdc-speedtest [options]

Options:
  -n, --network <name>       Network name (default: "baseSepolia")
  -p, --parallel <count>     Number of parallel testers (default: 5)
  -d, --duration <seconds>   Test duration in seconds (default: 60)
  --rpc <url>                Override RPC endpoint
  --usdc-address <addr>      Override USDC contract address
  --chain-id <id>            Override chain ID
  --cleanup                  Sweep funds from derived wallets back to master
  --skip-funding             Skip the funding step (wallets already funded)
```

The private key comes from `process.env.PRIVATE_KEY` (loaded via `dotenv`).

Flow:
1. Parse args, load env, resolve network config
2. Derive wallets
3. If `--cleanup` → run sweep mode, exit
4. Check balances of all derived wallets
5. If funding needed → show plan, prompt confirm, send funding txs, wait
6. Prompt confirm to start test
7. Run parallel testers for `--duration` seconds (or until Ctrl+C)
8. Print summary statistics

### Step 4: Wallet Derivation (`src/wallet/derive.ts`)

**Scheme:** Use the master private key (32 bytes) as entropy for a BIP-39 mnemonic, then derive child wallets via standard BIP-44 paths.

```typescript
function deriveWallets(masterPrivateKey: string, count: number): ethers.HDNodeWallet[] {
  // masterPrivateKey is 32 bytes → 24-word mnemonic
  const mnemonic = ethers.Mnemonic.fromEntropy(masterPrivateKey);
  const hdNode = ethers.HDNodeWallet.fromMnemonic(mnemonic, "m/44'/60'/0'/0");

  const wallets: ethers.HDNodeWallet[] = [];
  for (let i = 0; i < count; i++) {
    wallets.push(hdNode.deriveChild(i));
  }
  return wallets;
}
```

For `N` parallel testers, derive `2N` wallets. Pair them as:
- Tester 0: wallet[0] ↔ wallet[1]
- Tester 1: wallet[2] ↔ wallet[3]
- Tester k: wallet[2k] ↔ wallet[2k+1]

The **even wallets** (0, 2, 4, ...) are the "senders" that need USDC initially. The **odd wallets** (1, 3, 5, ...) only need ETH for gas (they'll receive USDC during the test and send it back).

### Step 5: Balance Checking & Funding Plan (`src/wallet/fund.ts`)

For each derived wallet, check:
1. **ETH balance** — must be ≥ `minEthPerWallet` for the selected network
2. **USDC balance** (even wallets only) — must be ≥ 10,000 (= $0.01 with 6 decimals)

Build a funding plan:
```typescript
type FundingPlan = {
  ethTransfers: { to: string; amount: bigint }[];   // from master
  usdcTransfers: { to: string; amount: bigint }[];  // from master
  totalEthNeeded: bigint;
  totalUsdcNeeded: bigint;
};
```

Display the plan in a table:
```
Funding Plan for 10 wallets on Base Sepolia:
  ETH needed:  0.05 ETH across 10 wallets (0.005 each)
  USDC needed: $0.05 across 5 wallets ($0.01 each)

  Wallet  Address                                     ETH Needed   USDC Needed
  #0      0xabc...def                                 0.005        $0.01
  #1      0x123...456                                 0.005        —
  ...
```

Then prompt: `Proceed with funding? (y/N)`

### Step 6: Funding Execution

After confirmation:

1. **ETH transfers**: Send individual transactions from master wallet to each wallet needing ETH. These can be sent with nonce management to pipeline them:
   - Fetch the master wallet's current nonce
   - Build all ETH transfer txs with sequential nonces
   - Broadcast all, then `Promise.all()` the receipt waits

2. **USDC transfers**: Same pattern — ERC-20 `transfer()` calls from master.

3. Wait for all receipts. Report success/failure for each.

**Nonce management**: We manually assign nonces to allow pipelining multiple transactions from the same sender without waiting for each to confirm. This is critical for throughput on slower networks.

### Step 7: Test Runner (`src/test/runner.ts`)

```typescript
async function runTest(
  pairs: WalletPair[],
  provider: ethers.JsonRpcProvider,
  usdcAddress: string,
  durationMs: number
): Promise<TestResult[]>
```

1. Prompt: `Ready to start test with N parallel testers for D seconds. This will spend gas. Continue? (y/N)`
2. Set up Ctrl+C handler (`process.on('SIGINT', ...)`) to signal graceful stop
3. Create a shared `AbortController` (or simple boolean flag)
4. Start a timer for `durationMs`
5. Spawn N testers concurrently via `Promise.all()`
6. When timer fires OR Ctrl+C received → set stop flag
7. Await all testers to finish their current tx and return
8. Aggregate and print stats

### Step 8: Individual Tester (`src/test/tester.ts`)

Each tester works with a pair of wallets (A and B):

```typescript
async function runTester(
  walletA: ethers.Wallet,
  walletB: ethers.Wallet,
  provider: ethers.JsonRpcProvider,
  usdcAddress: string,
  stopSignal: { stopped: boolean }
): Promise<TesterResult>
```

Loop:
1. `direction = true` (A→B initially)
2. While not stopped:
   a. Sender = direction ? A : B
   b. Receiver = direction ? B : A
   c. Record `startTime = Date.now()`
   d. Send USDC transfer: `usdc.connect(sender).transfer(receiver.address, 10000)` ($0.01)
   e. Wait for receipt
   f. Record `endTime = Date.now()`
   g. Record: `{ latencyMs: endTime - startTime, gasUsed: receipt.gasUsed, txHash }`
   h. Flip direction
3. Return all recorded transaction data

**Nonce management per wallet**: Since each wallet is used by exactly one tester and sends transactions sequentially (it alternates turns), nonce management is naturally sequential — no conflicts.

### Step 9: Statistics (`src/test/stats.ts`)

Collect from all testers:

```typescript
type TestSummary = {
  totalTransactions: number;
  totalDurationMs: number;
  totalGasUsed: bigint;
  transactionsPerSecond: number;
  avgLatencyMs: number;
  minLatencyMs: number;
  maxLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  avgGasPerTx: number;
  perTesterBreakdown: TesterSummary[];
};
```

Display:
```
═══════════════════════════════════════════════════════
  USDC Speedtest Results — Base Sepolia
═══════════════════════════════════════════════════════
  Duration:              60.2s
  Parallel testers:      5
  Total transactions:    312
  Throughput:            5.18 tx/s

  Latency (ms):
    Average:             965
    Median (p50):        920
    p95:                 1,450
    p99:                 2,100
    Min:                 680
    Max:                 3,200

  Gas:
    Total used:          20,280,000
    Average per tx:      65,000

  Per-tester breakdown:
    Tester #0:  63 txs,  avg 950ms
    Tester #1:  62 txs,  avg 972ms
    ...
═══════════════════════════════════════════════════════
```

### Step 10: Cleanup / Sweep Mode (`src/cleanup/sweep.ts`)

When `--cleanup` is passed:

1. Derive the same wallets (same master key, same count)
2. For each wallet, check USDC and ETH balances
3. Build a sweep plan:
   - Transfer all USDC back to master wallet
   - Transfer all ETH back to master wallet (minus gas for the transfer itself)
4. Display the plan, prompt confirm
5. Execute:
   - First: USDC transfers (need gas to execute)
   - Then: ETH transfers (sweep remaining ETH)
6. Report final balances

### Step 11: Interactive Prompts (`src/utils/prompt.ts`)

Simple `readline`-based confirm helper (no heavy dependency needed):

```typescript
async function confirm(message: string): Promise<boolean>
```

Two confirmation points in the normal flow:
1. Before funding derived wallets
2. Before starting the test

One confirmation point in cleanup mode:
1. Before sweeping funds back

### Step 12: USDC Contract Helpers (`src/utils/usdc.ts`)

Minimal ERC-20 ABI (just what we need):
- `transfer(address to, uint256 amount) returns (bool)`
- `balanceOf(address owner) returns (uint256)`
- `decimals() returns (uint8)`

```typescript
const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)"
];
```

---

## Key Design Decisions

### 1. HD Derivation from Private Key
Use the master private key as 32-byte entropy → BIP-39 mnemonic → BIP-44 HD tree. This is deterministic, standards-compliant, and means the same wallets are always derived for the same master key.

### 2. Nonce Pipelining for Funding
During the funding phase, we send many txs from the master wallet. We pipeline these by manually assigning nonces rather than waiting for each tx to confirm before sending the next.

### 3. No Concurrent Access to Same Wallet
Each wallet is used by exactly one tester in a strictly alternating pattern. No nonce conflicts, no locking needed.

### 4. Graceful Shutdown
Ctrl+C sets a stop flag. Each tester checks the flag between transactions (never mid-transaction). This ensures we don't leave dangling transactions and can collect stats for all completed txs.

### 5. Network Extensibility
Radius networks are defined with placeholder values. CLI flags (`--rpc`, `--usdc-address`, `--chain-id`) allow overriding any network config, so the tool works immediately when Radius launches USDC support.

---

## Dependencies

| Package | Purpose | Version |
|---|---|---|
| `ethers` | Wallets, contracts, providers, HD derivation | ^6.x |
| `commander` | CLI argument parsing | ^12.x |
| `dotenv` | Load `.env` for PRIVATE_KEY | ^16.x |
| `chalk` | Colored terminal output | ^5.x |
| `ora` | Progress spinners | ^8.x |
| `typescript` | (dev) Type checking | ^5.x |
| `tsup` | (dev) Bundling for npx distribution | ^8.x |
| `@types/node` | (dev) Node.js type definitions | ^22.x |

---

## File Creation Order

1. `package.json`, `tsconfig.json`, `tsup.config.ts`
2. `src/config/networks.ts` — network definitions
3. `src/utils/usdc.ts` — ERC-20 ABI & helpers
4. `src/utils/prompt.ts` — interactive confirm
5. `src/utils/logger.ts` — formatted output
6. `src/wallet/derive.ts` — HD wallet derivation
7. `src/wallet/fund.ts` — balance check & funding execution
8. `src/test/tester.ts` — individual ping-pong tester
9. `src/test/stats.ts` — statistics collection & display
10. `src/test/runner.ts` — orchestrate parallel testers
11. `src/cleanup/sweep.ts` — sweep funds back to master
12. `src/cli.ts` — entry point tying it all together
