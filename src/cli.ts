import { Command } from "commander";
import { config as dotenvConfig } from "dotenv";
import { Contract, formatEther, JsonRpcProvider, Wallet } from "ethers";
import chalk from "chalk";
import {
  getNetwork,
  getNetworkNames,
  applyOverrides,
} from "./config/networks.js";
import { deriveWallets, pairWallets } from "./wallet/derive.js";
import { checkAndFund } from "./wallet/fund.js";
import { runTest } from "./test/runner.js";
import { sweepFunds } from "./cleanup/sweep.js";
import { seedGas } from "./radius/seed-gas.js";
import { ERC20_ABI, USDC_CENT, formatUsdc } from "./utils/usdc.js";
import * as log from "./utils/logger.js";

dotenvConfig();

const program = new Command();

program
  .name("usdc-speedtest")
  .description(
    "Benchmark EVM network throughput by sending USDC transfers in parallel"
  )
  .version("1.0.0")
  .option(
    "-n, --network <name>",
    `network name (${getNetworkNames().join(", ")})`,
    "baseSepolia"
  )
  .option("-p, --parallel <count>", "number of parallel testers", "5")
  .option("-d, --duration <seconds>", "test duration in seconds")
  .option("--traffic-shape", "vary load over time using a random traffic curve")
  .option("--rpc <url>", "override RPC endpoint")
  .option("--usdc-address <addr>", "override USDC contract address")
  .option("--chain-id <id>", "override chain ID")
  .option("--ws <url>", "WebSocket RPC URL for block subscriptions")
  .option("--cleanup", "sweep funds from derived wallets back to master")
  .option("--skip-funding", "skip the wallet funding step")
  .option("--seed-gas <address>", "seed a target address with RUSD (Radius only)")
  .option("--seed-rounds <n>", "number of seed-gas iterations", "10");

program.parse();

const opts = program.opts();

async function main() {
  // Resolve network config
  let network = getNetwork(opts.network);
  network = applyOverrides(network, {
    rpc: opts.rpc,
    ws: opts.ws,
    usdcAddress: opts.usdcAddress,
    chainId: opts.chainId ? parseInt(opts.chainId) : undefined,
  });

  // Load private key
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    log.error(
      "PRIVATE_KEY environment variable is required. Set it in .env or your shell."
    );
    process.exit(1);
  }

  // Connect
  const provider = new JsonRpcProvider(network.rpcUrl, network.chainId, {
    staticNetwork: true,
  });

  // Verify the RPC's chain ID matches our config
  const rpcChainId = await provider.send("eth_chainId", []).then(
    (hex: string) => parseInt(hex, 16),
    () => null
  );
  if (rpcChainId != null && rpcChainId !== network.chainId) {
    log.error(
      `Chain ID mismatch: network "${opts.network}" is configured for chainId ${network.chainId}, but the RPC returned chainId ${rpcChainId}.`
    );
    log.error(
      `Use --chain-id ${rpcChainId} to override, or pick the correct -n network.`
    );
    process.exit(1);
  }

  const masterWallet = new Wallet(privateKey, provider);

  // --seed-gas: early exit, doesn't need USDC or derived wallets
  if (opts.seedGas) {
    if (!network.gasTokenAddress) {
      log.error(
        `--seed-gas requires a network with gasTokenAddress (e.g. radius).`
      );
      process.exit(1);
    }
    await seedGas(
      masterWallet,
      provider,
      network,
      opts.seedGas,
      parseInt(opts.seedRounds)
    );
    return;
  }

  if (!network.supported) {
    log.error(
      `Network "${opts.network}" is not yet fully supported. Use --rpc, --usdc-address, and --chain-id to provide configuration.`
    );
    process.exit(1);
  }

  const parallelCount = parseInt(opts.parallel);
  const trafficShape = !!opts.trafficShape;
  const durationSec = opts.duration
    ? parseInt(opts.duration)
    : trafficShape
      ? 1800
      : 60;
  const walletCount = parallelCount * 2;

  log.header("USDC Speedtest");
  log.info(`Network:    ${network.name} (chainId: ${network.chainId})`);
  log.info(`RPC:        ${network.rpcUrl}`);
  if (network.wsUrl) {
    log.info(`WebSocket:  ${network.wsUrl}`);
  }
  log.info(`Parallel:   ${parallelCount} testers (${walletCount} wallets)`);
  log.info(`Duration:   ${durationSec}s`);
  if (trafficShape) {
    log.info(`Mode:       traffic shaping`);
  }
  console.log();

  const gasLabel = network.gasTokenAddress ? "Gas Token" : "ETH";
  const [masterEth, masterUsdc] = await Promise.all([
    provider.getBalance(masterWallet.address),
    new Contract(network.usdcAddress, ERC20_ABI, provider)
      .balanceOf(masterWallet.address) as Promise<bigint>,
  ]);
  log.info(`Master wallet: ${masterWallet.address}`);
  log.info(`  ${gasLabel} balance: ${formatEther(masterEth)}`);
  log.info(`  USDC balance: ${formatUsdc(masterUsdc)}`);
  console.log();

  // Derive wallets
  const wallets = deriveWallets(privateKey, walletCount);
  log.info("Derived wallets:");
  for (let i = 0; i < wallets.length; i++) {
    const role = i % 2 === 0 ? chalk.cyan("sender  ") : chalk.magenta("receiver");
    log.info(`  #${i} ${role} ${wallets[i].address}`);
  }
  console.log();

  if (opts.cleanup) {
    await sweepFunds(wallets, masterWallet.address, provider, network);
    return;
  }

  // Estimate gas limits from the chain (once, cached for the whole run)
  const gasLimits = await estimateGasLimits(
    provider,
    masterWallet.address,
    wallets[0].address,
    network.usdcAddress,
    !!network.gasTokenAddress
  );
  log.info(
    `Gas limits: ETH transfer = ${gasLimits.ethTransfer}, ERC-20 transfer = ${gasLimits.erc20Transfer}`
  );
  console.log();

  // Check and fund wallets
  if (!opts.skipFunding) {
    await checkAndFund(wallets, masterWallet, provider, network, durationSec, gasLimits);
  }

  // Pair wallets and run test
  const pairs = pairWallets(wallets);
  await runTest(pairs, provider, network, durationSec, trafficShape, gasLimits);
}

main().catch((err) => {
  log.error(err.message || String(err));
  process.exit(1);
});

export type GasLimits = { ethTransfer: bigint; erc20Transfer: bigint };

async function estimateGasLimits(
  provider: JsonRpcProvider,
  fromAddress: string,
  toAddress: string,
  usdcAddress: string,
  isGasTokenChain: boolean
): Promise<GasLimits> {
  const BUFFER_NUM = 120n; // 20% safety margin
  const BUFFER_DEN = 100n;
  const DEFAULT_ETH = 21_000n;
  const DEFAULT_ERC20 = 100_000n;

  const iface = new Contract(usdcAddress, ERC20_ABI).interface;
  const data = iface.encodeFunctionData("transfer", [toAddress, USDC_CENT]);

  const erc20Raw = await provider
    .estimateGas({ from: fromAddress, to: usdcAddress, data })
    .catch(() => DEFAULT_ERC20);

  const erc20Transfer = (erc20Raw * BUFFER_NUM) / BUFFER_DEN;

  if (isGasTokenChain) {
    // On gas-token chains, native ETH transfers are unused — gas token funding
    // is also ERC-20, so ethTransfer = erc20Transfer.
    return { ethTransfer: erc20Transfer, erc20Transfer };
  }

  const ethRaw = await provider
    .estimateGas({ from: fromAddress, to: toAddress, value: 1n })
    .catch(() => DEFAULT_ETH);

  return {
    ethTransfer: (ethRaw * BUFFER_NUM) / BUFFER_DEN,
    erc20Transfer,
  };
}
